/**
 * A plan the Claude Code mod already approved, answered by the classic
 * PermissionRequest command hook without opening a second review (#2007).
 *
 * The mod's plan review is two hops: the reviewer approves in Plannotator,
 * Claude calls ExitPlanMode again, the mod's `tool.call` hook lets that call
 * through, and its `classic.PermissionRequest` hook allows it with the
 * approved text. On Team/Enterprise accounts Claude Code seats its built-in
 * guard (`cc-plugin-sec-default`) above the person's plugins, and the guard
 * sends `classic.PermissionRequest` past the mod. The event then reaches the
 * plugin's own command hook (`plannotator` with the PermissionRequest event on
 * stdin), which used to open a second review server, while Claude Code asked
 * in the terminal as well.
 *
 * So while that approved call is in flight, the mod also writes the approval
 * to `<data dir>/claude-code-mod/<session>/plan-approvals/<tool use>.json`
 * (owner-only folder) and removes it when the call settles. The command hook
 * looks there first: a fresh record for this session whose plan is the one
 * being requested is taken (deleted, so it answers once) and answered with the
 * same allow the mod would have given. Without the guard the mod answers first
 * and the command hook never runs, so nothing changes there.
 *
 * The mod keeps a copy of the names below (`hooks/mod/plan.ts`; a hooks
 * module may import only its own files); `mod-plan-approval.test.ts` keeps
 * them equal.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudePlan } from "./claude-plan";

/** The folder under the session's mod folder that holds approvals in flight. */
export const MOD_PLAN_APPROVALS_DIR = "plan-approvals";
/** The record's version. */
export const MOD_PLAN_APPROVAL_VERSION = 1;
/** A record older than this is left alone: the call it was written for is long gone. */
export const MOD_PLAN_APPROVAL_MAX_AGE_MS = 10 * 60_000;

/** At most this many records are looked at (the mod writes one per approved call). */
const MAX_RECORDS = 32;
/** The approved plan is capped at 2 MB; its JSON fits well inside this. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface ModPlanApprovalRecord {
  v: number;
  /** SHA-256 hex of the approved plan, trailing whitespace dropped. */
  hash: string;
  /** The text the reviewer approved. */
  plan: string;
  /** The permission mode the reviewer chose, if any. */
  permissionMode?: string;
  /** When the mod wrote it, ms since the epoch. */
  at: number;
}

/** The mod's path segment rule (`launchDirOf` in `hooks/mod/launch.ts`). */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Trailing whitespace is not a different plan (the mod's `normalizePlanForHash`). */
export function modPlanHash(plan: string): string {
  return createHash("sha256").update(plan.replace(/\s+$/, ""), "utf8").digest("hex");
}

/** The folder the mod writes this session's approvals to; null for a session id that cannot name one. */
export function modPlanApprovalsDir(dataDir: string, sessionId: unknown): string | null {
  if (typeof sessionId !== "string") return null;
  const segment = safeSegment(sessionId);
  if (!segment || /^\.+$/.test(segment)) return null;
  return join(dataDir, "claude-code-mod", segment, MOD_PLAN_APPROVALS_DIR);
}

/** Whether a file belongs to the user running this hook (always true where uids do not exist). */
function ownedByMe(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function parseRecord(text: string): ModPlanApprovalRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    if (value.v !== MOD_PLAN_APPROVAL_VERSION) return null;
    if (typeof value.hash !== "string" || typeof value.plan !== "string" || typeof value.at !== "number") return null;
    if (value.permissionMode !== undefined && typeof value.permissionMode !== "string") return null;
    return value as unknown as ModPlanApprovalRecord;
  } catch {
    return null;
  }
}

export interface ModPlanApprovalDecision {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
  updatedPermissions?: Array<{ type: "setMode"; mode: string; destination: "session" }>;
}

/**
 * The allow for an ExitPlanMode PermissionRequest whose plan the mod already
 * approved in this session, taking (deleting) the record; null otherwise, and
 * the classic review runs as before.
 */
export function takeModPlanApproval(
  event: Record<string, any>,
  options: { dataDir: string; now: number },
): ModPlanApprovalDecision | null {
  if (event.hook_event_name !== "PermissionRequest" || event.tool_name !== "ExitPlanMode") return null;
  // A subagent's ExitPlanMode keeps the classic flow (the mod never passes one).
  if (event.agent_id) return null;
  const dir = modPlanApprovalsDir(options.dataDir, event.session_id);
  if (!dir) return null;

  let names: string[];
  try {
    // A real folder of this user's: never a symlink to somewhere else, never another user's.
    const folder = lstatSync(dir);
    if (!folder.isDirectory() || !ownedByMe(folder.uid)) return null;
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_RECORDS);
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const toolInput: Record<string, unknown> =
    event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  // The plan the mod matched (the plan file when trustable, #1667), and the inline one.
  const wanted = new Set<string>();
  for (const plan of [resolveClaudePlan(toolInput), typeof toolInput.plan === "string" ? toolInput.plan : ""]) {
    if (plan.trim()) wanted.add(modPlanHash(plan));
  }
  if (wanted.size === 0) return null;

  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || !ownedByMe(stat.uid)) continue;
      const record = parseRecord(readFileSync(path, "utf8"));
      if (!record) continue;
      // The approved text must be the plan the hash names: a record whose plan
      // was swapped would allow a plan nobody reviewed.
      if (modPlanHash(record.plan) !== record.hash) continue;
      const age = options.now - record.at;
      if (age > MOD_PLAN_APPROVAL_MAX_AGE_MS || age < -60_000) continue;
      if (!wanted.has(record.hash)) continue;
      // Taken once: whoever deletes it answers.
      unlinkSync(path);
      return {
        behavior: "allow",
        // Claude Code drops an ExitPlanMode allow without updatedInput
        // (>= 2.1.199); carry the text the reviewer approved.
        updatedInput: { ...toolInput, plan: record.plan },
        ...(record.permissionMode
          ? { updatedPermissions: [{ type: "setMode" as const, mode: record.permissionMode, destination: "session" as const }] }
          : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}
