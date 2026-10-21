/**
 * Annotate: save a version when the open file changes on disk (#2037).
 *
 * An open single-file Markdown annotate session already shows an agent's
 * edit as soon as the file changes (the editor watches the file and reloads
 * the text in place). This module lets that reload also become a version in
 * the file's annotate history, so the `+N/-M` badge and the Version Browser
 * show the edit in the same session instead of only after a reopen.
 *
 * The editor asks for it with `POST /api/plan/versions` once the file has
 * settled, naming the source hash of the text it now shows. The server reads
 * the file ITSELF (a client never supplies the text that is saved) and saves
 * it only when the bytes on disk still have that hash, so the saved version is
 * exactly the text on the reviewer's screen. The save goes through the same
 * pipeline as opening the file (`computeAnnotateHistory`: dedupe against the
 * latest version, then look up the one before it), so an edit that put the
 * file back to the latest version saves nothing.
 *
 * Never on a GET, and never when `PLANNOTATOR_ANNOTATE_HISTORY=0` /
 * `{ "annotateHistory": false }`: the caller passes the resolved knob and the
 * route answers `409 history_off` without touching the data dir.
 *
 * Runtime-agnostic (node:fs through ./source-save-node and ./storage), so the
 * Bun annotate server and the Pi mirror share every decision here; each
 * adapter only parses the body and writes the response.
 */

import { statSync } from "node:fs";
import { computeAnnotateHistory, type AnnotateHistoryResult } from "./annotate-history";
import { readSourceFileSnapshot } from "./source-save-node";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/core/annotatable";
import { isSourceSaveFilePath } from "@plannotator/core/source-save";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/core/server-session";

/** The route the editor posts to; GET on the same path lists versions. */
export const ANNOTATE_LIVE_VERSION_PATH = "/api/plan/versions";

export interface AnnotateLiveVersionContext {
  /** The server's stale-tab nonce. */
  serverSession: string;
  /** `resolveAnnotateHistory(loadConfig())`, read once at server start. */
  historyEnabled: boolean;
  /**
   * The session's own file when it may save live versions: a single local
   * annotate session whose file Edit Mode may write (Markdown/text:
   * `isSourceSaveFilePath`), so not raw HTML, a converted page, a data file
   * (.yaml, .json), a diagram source, a URL, folder, bundle, message or live
   * app. Null otherwise. Use `annotateLiveVersionFilePath` to compute it.
   */
  resolvedFilePath: string | null;
  /** History project namespace (same one the open-time save used). */
  project: string;
  /** Test seam; defaults to the real file read. */
  readSnapshot?: (path: string) => { text: string; hash: string };
  /** Test seam; defaults to `statSync(path).size`. */
  sizeOf?: (path: string) => number;
}

export type AnnotateLiveVersionOutcome =
  | { status: 200; body: AnnotateLiveVersionSaved; history: AnnotateHistoryResult }
  | { status: 400 | 404 | 409 | 413 | 500; body: { ok: false; code: string; error: string } };

export interface AnnotateLiveVersionSaved {
  ok: true;
  /** False when the text equals the latest version (nothing was written). */
  saved: boolean;
  previousPlan: string | null;
  versionInfo: AnnotateHistoryResult["versionInfo"];
}

function refuse(status: 400 | 404 | 409 | 413 | 500, code: string, error: string): AnnotateLiveVersionOutcome {
  return { status, body: { ok: false, code, error } };
}

/**
 * Decide and run one live version save. `body` is the parsed JSON request
 * body (`{ serverSession?, hash }`); anything that is not an object is a 400.
 */
export function saveAnnotateLiveVersion(
  body: unknown,
  ctx: AnnotateLiveVersionContext,
): AnnotateLiveVersionOutcome {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "validation_error", "Expected a JSON object.");
  }
  if (checkServerSession(body, ctx.serverSession) === "mismatch") {
    const mismatch = serverSessionMismatchBody();
    return refuse(409, mismatch.code, mismatch.error);
  }
  const hash = (body as Record<string, unknown>).hash;
  if (typeof hash !== "string" || hash.length === 0 || hash.length > 200) {
    return refuse(400, "validation_error", "hash: the source hash of the text on screen is required.");
  }
  if (!ctx.resolvedFilePath) {
    return refuse(404, "not_eligible", "Live versions are kept only for a single local Markdown or text file.");
  }
  if (!ctx.historyEnabled) {
    return refuse(409, "history_off", "Annotate history is turned off (PLANNOTATOR_ANNOTATE_HISTORY=0).");
  }

  // The annotate cap (2 MB), checked before the read and again on the bytes
  // read, so a file that grew past it is never read whole or saved.
  const tooLarge = () => refuse(413, "too_large", "The file is too large to keep as a version (max 2MB).");
  let snapshot: { text: string; hash: string };
  try {
    if ((ctx.sizeOf ?? ((path: string) => statSync(path).size))(ctx.resolvedFilePath) > MAX_ANNOTATABLE_FILE_BYTES) {
      return tooLarge();
    }
    snapshot = (ctx.readSnapshot ?? readSourceFileSnapshot)(ctx.resolvedFilePath);
  } catch {
    return refuse(409, "missing", "The file could not be read.");
  }
  if (new TextEncoder().encode(snapshot.text).byteLength > MAX_ANNOTATABLE_FILE_BYTES) return tooLarge();
  if (snapshot.hash !== hash) {
    // The file moved on since the editor read it; the next change event
    // brings the newer text and asks again.
    return refuse(409, "stale", "The file changed again; nothing was saved.");
  }
  // The open-time rule: an empty file is never a version.
  if (snapshot.text.length === 0) {
    return refuse(409, "empty", "The file is empty; nothing was saved.");
  }

  const history = computeAnnotateHistory(ctx.project, ctx.resolvedFilePath, snapshot.text);
  if (!history) {
    return refuse(500, "history_unavailable", "The version could not be saved.");
  }
  return {
    status: 200,
    history,
    body: {
      ok: true,
      saved: history.isNew,
      previousPlan: history.previousPlan,
      versionInfo: history.versionInfo,
    },
  };
}

/**
 * The file a session may save live versions of, or null: a single local
 * annotate session (`mode === "annotate"`, not a URL) that Edit Mode could
 * write (not raw HTML or a converted page), whose named path and, when known,
 * real path are Markdown/text (`isSourceSaveFilePath`). Returns the resolved
 * named path, the same one the open-time history save keys by.
 */
export function annotateLiveVersionFilePath(input: {
  sourceSaveEligible: boolean;
  resolvedFilePath: string;
  realFilePath: string | null;
}): string | null {
  if (!input.sourceSaveEligible) return null;
  if (!isSourceSaveFilePath(input.resolvedFilePath)) return null;
  if (input.realFilePath && !isSourceSaveFilePath(input.realFilePath)) return null;
  return input.resolvedFilePath;
}
