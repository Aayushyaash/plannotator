/**
 * The read-only permission policy every agent runs under, whatever its own
 * settings say. A guide only reads: the agent's own tools may read and search,
 * and the builder's MCP tools change nothing but the draft in the extension.
 *
 * Each `session/request_permission` is decided here before anyone is asked:
 *
 * - `edit`, `delete`, `move`: change files. Refused without asking.
 * - `execute`: runs a command, which can do anything (a shell command that
 *   "only reads" is not something a client can verify). Refused without asking.
 * - `switch_mode`: could leave a read-only mode for one that edits. Refused.
 * - `fetch`: reads the network. Asked in a local-changes run; refused in a
 *   pull request run, because a PR's text is someone else's and could steer the
 *   agent into sending what it read somewhere (read + fetch is a way out).
 * - `read`, `search`, `think`: asked (only "allow once" and "reject" are
 *   offered: an "always allow" would write a rule into the user's settings).
 * - `other`, or no kind: the builder's own tools (`guide_*`, matched by their
 *   exact programmatic name or title) are allowed once without asking; any
 *   other tool is asked, because a client cannot tell what it does.
 *
 * The kind is the request's own, else the kind the agent reported for the same
 * tool call in an earlier `tool_call` update.
 */

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolKind } from "@agentclientprotocol/sdk";
import { GUIDE_BUILDER_TOOL_NAMES } from "../core/adapter";

export type RunKind = "local" | "pr";

export type PermissionDecision =
  | { action: "refuse"; reason: string }
  /** Show these options (allow once and reject only) and pass the user's choice back. */
  | { action: "ask"; options: PermissionOption[] }
  /** Our own builder tool: allow once without asking. */
  | { action: "allow"; optionId: string };

/** Kinds that change files or run commands: never allowed. */
export const REFUSED_KINDS: readonly ToolKind[] = ["edit", "delete", "move", "execute", "switch_mode"];

/** Every ACP tool kind (the SDK's union), for the table and its test. */
export const ALL_TOOL_KINDS: readonly ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"];

const KIND_WORDS: Record<string, string> = {
  edit: "edits files",
  delete: "deletes files",
  move: "moves files",
  execute: "runs a command",
  switch_mode: "changes the agent's mode",
  fetch: "reads the network",
};

const BUILDER_NAMES = new Set<string>(GUIDE_BUILDER_TOOL_NAMES as readonly string[]);

/**
 * Whether a tool call is one of the builder's own MCP tools: its programmatic
 * name, or its whole title, is a builder tool name, bare or with the server's
 * prefix as agents spell it (`mcp__plannotator-guide__guide_finish`,
 * `plannotator-guide.guide_finish`, `plannotator-guide/guide_finish`,
 * `plannotator-guide_guide_finish`, `plannotator-guide: guide_finish`). A title
 * that merely contains a builder name (a shell command does) is not one.
 */
export function isBuilderToolCall(toolCall: { name?: string | null; title?: string | null }): boolean {
  for (const raw of [toolCall.name, toolCall.title]) {
    if (typeof raw !== "string") continue;
    const m = /^(?:(?:mcp__)?plannotator-guide(?:__|[._/]|: ?))?(guide_[a-z_]+)$/.exec(raw.trim());
    if (m && BUILDER_NAMES.has(m[1])) return true;
  }
  return false;
}

/** Decide one permission request. `knownKind` is the kind from the earlier `tool_call` update, if any. */
export function decidePermission(request: RequestPermissionRequest, context: { run: RunKind; knownKind?: ToolKind | null }): PermissionDecision {
  const kind = (request.toolCall.kind ?? context.knownKind ?? null) as ToolKind | null;
  if (kind && REFUSED_KINDS.includes(kind)) {
    return { action: "refuse", reason: `It ${KIND_WORDS[kind]}; guided reviews are read-only.` };
  }
  if (kind === "fetch" && context.run === "pr") {
    return { action: "refuse", reason: "It reads the network; a pull request run does not, so the PR's text cannot send what the agent read anywhere." };
  }
  const allowOnce = request.options.find((o) => o.kind === "allow_once");
  if ((kind === null || kind === "other") && isBuilderToolCall(request.toolCall) && allowOnce) {
    return { action: "allow", optionId: allowOnce.optionId };
  }
  const options = request.options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once" || o.kind === "reject_always");
  if (!options.some((o) => o.kind === "allow_once")) {
    // Only "always allow" offered: a once-only answer is not possible, so it is refused.
    return { action: "refuse", reason: "The agent offered only to allow it always, which would change your settings." };
  }
  return { action: "ask", options };
}

/** The agent's own reject option (once, else always), else `cancelled`. */
export function refusalResponse(request: RequestPermissionRequest): RequestPermissionResponse {
  const reject = request.options.find((o) => o.kind === "reject_once") ?? request.options.find((o) => o.kind === "reject_always");
  return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
}

/**
 * The answer to send back after asking: the user's choice when it is one of
 * the options we offered, else a refusal (an "always allow" never passes).
 */
export function vetAnswer(request: RequestPermissionRequest, offered: readonly PermissionOption[], answer: RequestPermissionResponse): RequestPermissionResponse {
  if (answer.outcome.outcome !== "selected") return answer;
  const id = answer.outcome.optionId;
  return offered.some((o) => o.optionId === id) ? answer : refusalResponse(request);
}

/** Kinds that, when a tool call of that kind completes, mean a file changed. */
export const WRITE_KINDS: readonly ToolKind[] = ["edit", "delete", "move"];
