/**
 * Plannotator Inbox: action items an agent needs the person to go do (approval
 * "inbox-next-actions", 2026-10-21, direction "In the thread").
 *
 * An agent writes a `:::action` block in a message body when it is stopped
 * on something only the person can do outside the conversation (approve a
 * deploy, sign in, touch a security key, merge a PR it cannot merge):
 *
 *   :::action
 *   Approve the production deploy on Vercel
 *   The 4.2 build passed every check and waits under "Promote to Production".
 *   Where: https://vercel.com/acme/web/deployments/dpl_8Hk2mQ
 *   Stopped: release 4.2 to production
 *   Watching: the deployment; I go on by myself once it is Ready.
 *   :::
 *
 * The first non-empty line is what to do (an order). Other lines are the why,
 * except these labelled ones (the first of each wins, any case):
 *
 *   Where: <url>, [name](url), "<name> <url>", or a place in words
 *   Run: <a command to copy>             (backticks around it are dropped)
 *   Stopped: <why> / Holds up: <a>; <b>  (as for questions, with the same
 *                                         negative-word guard)
 *   Watching: <what the agent watches>   (it will notice it done by itself)
 *   Replaces: <message id>/<a-key> …     (only when every token is an action item's id)
 *
 * This grammar is the Inbox's only: Plannotator's question grammar (and so
 * plan review) is unchanged. The block is found with core's directive scanner
 * (`findDirectiveBlocks`), so code fences and HTML blocks hide it exactly as
 * they hide a question. The store keeps each block as a question record of
 * kind `"action"` (key `a-` + hash8 of the first line), so its states,
 * Stopped / Holds up, Mark read, Re-ask and supersede, the reply and the wake
 * are the questions' own.
 *
 * Pure: no I/O, no clock unless passed in. Never throws on any input.
 */

import { blockKeyHash8, findDirectiveBlocks, MAX_QUESTION_PROMPT_CHARS, normalizeQuestionText } from "./question-block";
import { isNegativeWaitValue } from "./inbox-questions";
import { cutText } from "./text-cut";
import type { InboxActionFacts, InboxActionResult, InboxQuestionRecord } from "./inbox-types";

/** The directive an agent writes: `:::action`. */
export const INBOX_ACTION_DIRECTIVE = "action";

/** What the window calls it ("Action item · something only you can do"). */
export const INBOX_ACTION_LABEL = "Action item";

/** `a-` + hash8 of the normalized first line: a reworded action item is a new action item. */
export function inboxActionKey(prompt: string): string {
  return `a-${blockKeyHash8(`action\n${normalizeQuestionText(prompt)}`)}`;
}

/** An action item's key, `-2`, `-3`… for repeats in one message included. */
export const INBOX_ACTION_KEY_RE = /^a-[0-9a-f]{8}(?:-\d{1,3})?$/;

/** One `:::action` block of a message body, in block order. */
export interface ParsedInboxAction {
  key: string;
  /** Its place among the message's action items (A1 is 0). */
  position: number;
  /** What to do: the block's first non-empty line, plain. */
  prompt: string;
  /** The other lines, the why; null when there are none. */
  why: string | null;
  action: InboxActionFacts;
  stopped: string | null;
  holds_up: string[];
  /** The block's `Replaces:` ids, as written (checked by the store). */
  replaces: string[];
  /** 1-based line of the first line (what to do) in the body. */
  line: number;
  /** 1-based line of the opening `:::action`. */
  startLine: number;
}

const LABEL_RE = /^(where|run|stopped|holds up|watching|replaces)\s*:\s*(.*)$/i;
// An action item replaces only an action item: `<message id>/a-…`, or `<message id>` (its action items).
const ID_TOKEN = String.raw`msg_[0-9A-HJKMNP-TV-Z]{26}(?:/a-[0-9a-f]{8}(?:-\d{1,3})?)?\.?`;
const REPLACES_VALUE_RE = new RegExp(String.raw`^(${ID_TOKEN}(?:[\s,;]+${ID_TOKEN})*)[\s,;]*$`);

/** The first line, plain: a heading mark, a list marker and emphasis around the whole line dropped. */
function plainPrompt(line: string): string {
  let text = line.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "");
  const emphasis = /^(\*\*|__|\*|_)(.+)\1$/.exec(text);
  if (emphasis) text = emphasis[2]!.trim();
  return cutText(text.replace(/\s+/g, " ").trim(), MAX_QUESTION_PROMPT_CHARS);
}

/** An http(s) URL, or null (a link that could run anything never becomes a button). */
function httpUrl(value: string): string | null {
  const trimmed = value.trim().replace(/^<(.+)>$/, "$1");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `Where:`'s value: a link (with a name, or named by its host), else a place in words. */
export function parseInboxActionWhere(value: string): { where: string | null; where_url: string | null } {
  const text = value.trim();
  if (text === "") return { where: null, where_url: null };
  const link = /^\[([^\]]+)\]\((.+)\)\.?$/.exec(text);
  if (link) {
    const url = httpUrl(link[2]!);
    return url ? { where: link[1]!.trim() || hostOf(url), where_url: url } : { where: link[1]!.trim(), where_url: null };
  }
  const found = /<?(https?:\/\/[^\s>]+)>?/i.exec(text);
  if (found) {
    const url = httpUrl(found[1]!.replace(/[.,;:!?)]+$/, ""));
    if (url) {
      const name = (text.slice(0, found.index) + text.slice(found.index + found[0].length))
        .replace(/^[\s:–—-]+|[\s:–—(-]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return { where: name || hostOf(url), where_url: url };
    }
  }
  return { where: text.replace(/\s+/g, " "), where_url: null };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `Run:`'s value: one pair of backticks (single or triple) around the whole command is dropped. */
function runCommand(value: string): string | null {
  let text = value.trim();
  const fenced = /^(`{1,3})(.+)\1$/.exec(text);
  if (fenced) text = fenced[2]!.trim();
  return text === "" ? null : text;
}

/**
 * One `:::action` block's inner text, read. Null when the block has no first
 * line (nothing to do).
 */
export function parseInboxActionBlock(inner: string): Omit<ParsedInboxAction, "key" | "position" | "line" | "startLine"> & { promptLine: number } | null {
  if (typeof inner !== "string") return null;
  const lines = inner.replace(/\r\n?/g, "\n").split("\n");
  let promptLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || LABEL_RE.test(line)) continue;
    promptLine = i;
    break;
  }
  if (promptLine === -1) return null;
  const prompt = plainPrompt(lines[promptLine]!);
  if (prompt === "") return null;
  const why: string[] = [];
  const seen = new Set<string>();
  const facts: InboxActionFacts = { where: null, where_url: null, run: null, watching: null };
  let stopped: string | null = null;
  let holdsUp: string[] = [];
  let replaces: string[] = [];
  lines.forEach((raw, index) => {
    if (index === promptLine) return;
    const line = raw.trim();
    const label = LABEL_RE.exec(line);
    const name = label?.[1]!.toLowerCase() ?? null;
    if (label && name === "replaces" && !REPLACES_VALUE_RE.test(label[2]!.trim())) {
      // Not ids: prose, read as the why.
      why.push(raw);
      return;
    }
    if (!label || !name) {
      why.push(raw);
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    const value = label[2]!.trim();
    if (name === "where") Object.assign(facts, parseInboxActionWhere(value));
    else if (name === "run") facts.run = runCommand(value);
    else if (name === "watching") facts.watching = value === "" ? null : value.replace(/\s+/g, " ");
    else if (name === "stopped") stopped = isNegativeWaitValue(value) ? null : value;
    else if (name === "holds up") holdsUp = value.split(";").map((v) => v.trim()).filter((v) => v !== "" && !isNegativeWaitValue(v));
    else if (name === "replaces") {
      replaces = value
        .split(/[\s,;]+/)
        .map((token) => token.replace(/\.$/, ""))
        .filter((token) => token !== "");
    }
  });
  const whyText = why.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { prompt, why: whyText === "" ? null : whyText, action: facts, stopped, holds_up: holdsUp, replaces, promptLine };
}

/**
 * The `:::action` blocks of a message body, in block order, keys
 * de-duplicated (`-2`, `-3`…) as question keys are. A body is read like a
 * comment: no frontmatter. [] when there is none.
 */
export function parseInboxActionBlocks(markdown: string): ParsedInboxAction[] {
  if (typeof markdown !== "string" || !/:::\s*action/i.test(markdown)) return [];
  const out: ParsedInboxAction[] = [];
  const seen = new Map<string, number>();
  for (const block of findDirectiveBlocks(markdown, { frontmatter: false })) {
    if (block.directiveKind !== INBOX_ACTION_DIRECTIVE) continue;
    const parsed = parseInboxActionBlock(block.inner);
    if (parsed === null) continue;
    const base = inboxActionKey(parsed.prompt);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const { promptLine, ...rest } = parsed;
    out.push({
      ...rest,
      key: count === 1 ? base : `${base}-${count}`,
      position: out.length,
      line: block.startLine + 1 + promptLine,
      startLine: block.startLine,
    });
  }
  return out;
}

// ─────────────────────────────── The person's result ───────────────────────────────

/** How long a note or a reason may be. */
export const INBOX_ACTION_NOTE_MAX = 2000;

/**
 * The person's Done or Can't do it, checked: `outcome` "done" (with an
 * optional note) or "cant" (with a reason, required). Null outcome: the Undo.
 */
export function checkInboxActionResult(
  raw: { outcome?: unknown; note?: unknown },
): { ok: true; outcome: "done" | "cant" | null; note: string | null } | { ok: false; field: string; message: string } {
  const outcome = raw.outcome;
  if (outcome === null) return { ok: true, outcome: null, note: null };
  if (outcome !== "done" && outcome !== "cant") return { ok: false, field: "outcome", message: 'outcome: "done", "cant", or null to undo.' };
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return { ok: false, field: "note", message: "note: text." };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > INBOX_ACTION_NOTE_MAX) return { ok: false, field: "note", message: `note: at most ${INBOX_ACTION_NOTE_MAX} characters.` };
  if (outcome === "cant" && note === "") return { ok: false, field: "note", message: "note: say why you can't do it; the agent gets it word for word." };
  return { ok: true, outcome, note: note === "" ? null : note };
}

// ─────────────────────────────── What the agent gets ───────────────────────────────

/** The section the reply carries (approval "inbox-next-actions", brief). */
export const INBOX_ACTIONS_HEADING = "Action items you asked for";

/** "3:12 PM" in the computer's own time (the person's clock). */
export function inboxActionTime(at: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  try {
    return date
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) })
      .replace(/\s/g, " ");
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

const actionsWord = (n: number): string => `${n} action item${n === 1 ? "" : "s"}`;

/**
 * The reply a Done or Can't do it sends: "Did 1 action item." (or "Couldn't do 1
 * action item.", "Did 1 action item, couldn't do 1."), then the section listing each
 * action item it reports, A-numbered as the card, with "Done, 3:12 PM." and the
 * note, or "Can't do it: <reason>". `all` is the message's action items, for the
 * "x of y done" line (an agent's own `done` counts as done).
 */
export function composeInboxActionsReply(input: {
  reported: readonly Pick<InboxQuestionRecord, "key" | "position" | "prompt" | "action_result">[];
  all: readonly Pick<InboxQuestionRecord, "key" | "position" | "action_result" | "superseded_by" | "sent_revision" | "revision">[];
  /** That message's questions and action items still waiting on the person, for the last line (#2059). */
  stillOpen?: readonly InboxStillOpenItem[];
  timeZone?: string;
}): string {
  const reported = [...input.reported].filter((r) => r.action_result).sort((a, b) => a.position - b.position);
  if (reported.length === 0) return "";
  const reportedKeys = new Set(reported.map((r) => r.key));
  const done = reported.filter((r) => r.action_result!.outcome === "done").length;
  const cant = reported.length - done;
  const sentence =
    done > 0 && cant > 0 ? `Did ${actionsWord(done)}, couldn't do ${cant}.` : done > 0 ? `Did ${actionsWord(done)}.` : `Couldn't do ${actionsWord(cant)}.`;
  const live = input.all.filter((r) => !r.superseded_by);
  const total = Math.max(live.length, reported.length);
  const doneAll = live.filter((r) => {
    if (reportedKeys.has(r.key)) return reported.find((x) => x.key === r.key)!.action_result!.outcome === "done";
    const result = r.action_result;
    if (!result || result.outcome !== "done") return false;
    return result.by === "agent" || (r.revision > 0 && r.sent_revision === r.revision);
  }).length;
  const items = reported.map((r) => {
    const result = r.action_result!;
    const head = `### A${r.position + 1}. ${r.prompt.replace(/\s+/g, " ").trim()}`;
    if (result.outcome === "cant") return `${head}\nCan't do it: ${(result.note ?? "").trim()}`;
    return [head, `Done, ${inboxActionTime(result.at, input.timeZone)}.`, ...(result.note ? [`Note: ${result.note.trim()}`] : [])].join("\n");
  });
  const open = inboxActionsStillOpenLine(input.stillOpen ?? []);
  return [sentence, `## ${INBOX_ACTIONS_HEADING}`, `${doneAll} of ${total} done.`, ...items, ...(open ? [open] : [])].join("\n\n");
}

/** A question (Q1…) or action item (A1…) of the message a report answers that still waits on the person. */
export interface InboxStillOpenItem {
  kind: "question" | "action";
  /** 0-based, as the record's `position`: Q1 / A1 is 0. */
  position: number;
  prompt: string;
}

/**
 * The report's last line when some of that message's questions or action
 * items still wait on the person (#2059), like the reply's still-open line:
 * "Still open: A2. Approve the 2FA prompt for the npm org — the person will
 * do it in the Inbox; don't ask again." Empty when nothing is open.
 */
export function inboxActionsStillOpenLine(items: readonly InboxStillOpenItem[]): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === "question" ? -1 : 1));
  const names = sorted.map((i) => `${i.kind === "action" ? "A" : "Q"}${i.position + 1}. ${i.prompt.replace(/\s+/g, " ").trim()}`);
  const one = items.length === 1;
  const actions = items.some((i) => i.kind === "action");
  const questions = items.some((i) => i.kind === "question");
  const verb = actions && questions ? "answer or do" : actions ? "do" : "answer";
  return `Still open: ${names.join("; ")} — the person will ${verb} ${one ? "it" : "them"} in the Inbox; don't ask again.`;
}

/** The card's words for an action item's result ("Done 3:12 PM", "Can't do it: …", "Claude Code saw it done"). */
export function inboxActionResultLine(result: InboxActionResult, agent: string, timeZone?: string): string {
  const time = inboxActionTime(result.at, timeZone);
  if (result.by === "agent") return `${agent} saw it done, ${time}`;
  if (result.outcome === "cant") return `Can't do it: ${result.note ?? ""}`.trim();
  return `Done ${time}`;
}

// ─────────────────────────────── The agent's own `done` ───────────────────────────────

const DONE_REF_RE = /^(msg_[0-9A-HJKMNP-TV-Z]{26})(?:\/(a-[0-9a-f]{8}(?:-\d{1,3})?))?$/;

/**
 * One id an agent marks done with (send_message's `done`): `<message id>`
 * (every open action item of that message) or `<message id>/<key>` (one). Null when
 * it is neither.
 */
export function parseInboxDoneRef(value: unknown): { message_id: string; key: string | null } | null {
  if (typeof value !== "string") return null;
  const match = DONE_REF_RE.exec(value.trim());
  if (!match) return null;
  return { message_id: match[1]!, key: match[2] ?? null };
}

// ─────────────────────────────── What agents are told ───────────────────────────────

/**
 * A `:::action` block as agents are shown it (send_message's `body`, the
 * agent guide). inbox-actions.test.ts parses it with the store's own reader.
 */
export const INBOX_ACTION_EXAMPLE = [
  ":::action",
  "Approve the production deploy on Vercel",
  'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
  "",
  "Where: https://vercel.com/acme/web/deployments",
  "Stopped: release 4.2 cannot go out until it is approved",
  "Watching: the deployment; I go on by myself once it is Ready",
  ":::",
].join("\n");

/**
 * When to write a `:::action` block, and when not (the owner: "only when
 * there's like a true blocker like a user actually has to do some shit").
 * Rides send_message's `body` description (it reaches the model whole) and
 * the agent guide. Never in QUESTION_AUTHORING_GUIDE: plan review shares it.
 */
export const INBOX_ACTION_GUIDE = [
  "An action item, only for a true blocker: something the person must go and do outside this conversation before you can go on, that you cannot do yourself (approve a deploy, sign in, touch a security key, click something in another app, merge a pull request you cannot merge). Write it as an Inbox-only `:::action` block: the first line is what to do, as an order; then why, in a line or two. Optional lines: `Where: <url or place>` (a URL becomes an Open button), `Run: <command>` (a command to copy), `Stopped:` / `Holds up:` as for questions, and `Watching: <what you watch>` when you will notice it done by yourself (then pass its id in `done`).",
  "Never use it for a decision or a question (ask a :::question), for anything you can do yourself, or as a checklist or a status update: one block per real blocker, and most messages need none. The person marks it Done or Can't do it (with a reason); that comes back in their reply under \"Action items you asked for\".",
].join("\n");

/** send_message's (and submit_guide's) `done`, as an agent reads it. */
export const INBOX_DONE_DESCRIPTION =
  "Your own action items (`:::action` blocks) in this thread that you saw done yourself, e.g. the deployment you were watching is Ready: \"<message id>/<key>\" for one (the key starts with a-; read_thread gives it) or \"<message id>\" for every open action item of that message. The card then says you saw it done, and nothing is sent to the person. Only your own action items that are still open (not one the person already marked) in the thread this message lands in (use reply_to); otherwise nothing is sent and the refusal, invalid_done, lists the thread's open action items. Never mark done what you did not see happen.";
