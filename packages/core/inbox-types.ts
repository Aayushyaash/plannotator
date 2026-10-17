/**
 * Plannotator Inbox: the browser-safe record and wire shapes.
 *
 * The Inbox is one long-lived local server (`plannotator inbox`) that holds
 * messages agents send and the person's answers. Its store is append-only
 * JSONL under `${dataDir}/inbox/` (packages/shared/inbox/), one full snapshot
 * per line; these are the shapes of those snapshots and of what the window's
 * API and the MCP tools answer with.
 *
 * Kept identical to Workspaces on the wire where the two overlap (the
 * `Question` shape, its derived `state`, `QuestionAnswer` v1, ISO-8601 UTC
 * times, snake_case fields), so a later sync is a mapping, not a migration.
 *
 * Browser-safe and dependency-free apart from core's own question model.
 */

import type { QuestionAnswer, QuestionKind } from "./question-block";
import type { InboxAnnotationRecord, InboxAttachment, InboxAttachmentKind, InboxInlineImage } from "./inbox-attachments";

// The attachment shapes and file rules (step 2) live in their own module and
// reach the Inbox through this published entry, so core's export map is unchanged.
export * from "./inbox-attachments";
export * from "./inbox-open-in";
// The surface bridge's messages (the phone, PLAN step S1), the same way.
export * from "./inbox-surface-bridge";

/** Every record and line carries this version. Fields are only ever added. */
export const INBOX_RECORD_VERSION = 1 as const;

// ─────────────────────────────── Ids ───────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID (48-bit millisecond time + 80 random bits, Crockford base32), so ids
 * sort by creation time and a later sync can keep them as they are.
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let randomPart = "";
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[bytes[i]! % 32];
  return timePart + randomPart;
}

/** `upl`: a file the person uploaded for a message; `drf`: a draft of one (compose). */
export type InboxIdPrefix = "msg" | "prj" | "ses" | "dec" | "dev" | "upl" | "drf";

export function inboxId(prefix: InboxIdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE: Record<InboxIdPrefix, RegExp> = {
  msg: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/,
  prj: /^prj_[0-9A-HJKMNP-TV-Z]{26}$/,
  ses: /^ses_[0-9A-HJKMNP-TV-Z]{26}$/,
  dec: /^dec_[0-9A-HJKMNP-TV-Z]{26}$/,
  /** A paired phone (adr/implementation/inbox-mobile.md, section 2). */
  dev: /^dev_[0-9A-HJKMNP-TV-Z]{26}$/,
  upl: /^upl_[0-9A-HJKMNP-TV-Z]{26}$/,
  drf: /^drf_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isInboxId(prefix: InboxIdPrefix, value: unknown): value is string {
  return typeof value === "string" && ID_RE[prefix].test(value);
}

// ─────────────────────────────── Thread names ───────────────────────────────

/** The longest `thread` name send_message takes, in characters. */
export const INBOX_THREAD_NAME_MAX = 120;

export const THREAD_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Bidi controls (LRE..RLO, LRI..PDI, LRM, RLM, ALM) reorder the text around
 * them, so a name holding one can draw as another name in the list.
 */
export const THREAD_NAME_BIDI = /\p{Bidi_Control}/u;
/** Code points that draw as nothing (zero-width space and joiners, BOM, variation selectors...). */
const THREAD_NAME_INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A `thread` name as sent: trimmed, 1..120 characters, no control characters
 * or line breaks, no bidi controls, and something visible in it (a name made
 * only of zero-width characters is empty).
 */
export function checkInboxThreadName(value: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: false, message: "must be a string." };
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || inboxThreadNameKey(name) === "") return { ok: false, message: "must not be empty." };
  if (length > INBOX_THREAD_NAME_MAX) return { ok: false, message: `at most ${INBOX_THREAD_NAME_MAX} characters.` };
  if (THREAD_NAME_CONTROL.test(name)) return { ok: false, message: "must not contain control characters or line breaks." };
  if (THREAD_NAME_BIDI.test(name)) return { ok: false, message: "must not contain bidirectional control characters." };
  return { ok: true, name };
}

/**
 * What two thread names are compared by: compatibility-normalized (NFKC, so
 * a full-width "\uff41\uff55\uff54\uff48" is "auth"), invisible code points dropped (a
 * zero-width space cannot make a second thread that looks like the first),
 * runs of whitespace as one space, case folded (upper then lower, so "\u00df" is
 * "ss"). "Auth refactor" and "auth  Refactor" are one thread. The stored
 * name keeps the first sender's spelling.
 */
export function inboxThreadNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(THREAD_NAME_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .toLowerCase();
}

// ─────────────────────────────── Records ───────────────────────────────

/** One row of the window: the repository or folder an agent works in. */
export interface InboxProject {
  id: string;
  /** The folder name under `inbox/projects/`: `<name>-<6 hex of the root>`. */
  key: string;
  name: string;
  /** Absolute realpath of the repository root (git toplevel) or folder. */
  root: string;
  created_at: string;
}

/**
 * The repository a project's git `origin` names (#1840): its path on the
 * forge (`owner/repo`, or a GitLab `group/sub/project`) and the remote's host,
 * null when the host did not parse. The window links bare `#123` refs with it.
 */
export interface InboxProjectRepo {
  display: string;
  host: string | null;
}

export type InboxAuthor =
  | { kind: "person" }
  | {
      kind: "agent";
      /** The agent host when known (`claude-code`, `codex`, ...). */
      host: string | null;
      /** The asking session: the stdio shim's own `ses_` id, or a host's session id. */
      session: string | null;
      /** A display name the agent gave itself. */
      name: string | null;
    };

/** The hosts whose names the Inbox knows, keyed by `author.host`. */
/**
 * One of the Inbox's own notes to the asking agent: Mark read's set-aside
 * note (`set_aside`), a late Undo's reopened note (`reopened`), or the note
 * that carries a 👍 Looks good to the agent (`ack_of`). They are stored as
 * the person's messages so they reach the agent like any reply, but they are
 * not the person's reply and not a look: the list's `sent`, `unseen`, the
 * look boundary and "came back" all read past them.
 */
export function isInboxNote(message: {
  author: { kind: string };
  set_aside?: readonly string[] | null;
  reopened?: readonly string[] | null;
  ack_of?: string | null;
}): boolean {
  return (
    message.author.kind === "person" &&
    ((message.set_aside?.length ?? 0) > 0 || (message.reopened?.length ?? 0) > 0 || (typeof message.ack_of === "string" && message.ack_of !== ""))
  );
}

export const INBOX_HOST_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  cursor: "Cursor",
};

/** How the person sees an agent: the name it gave, else its host's name, else "An agent". */
export function inboxAgentName(author: { kind: string; host?: string | null; name?: string | null } | null | undefined): string {
  if (!author || author.kind !== "agent") return "An agent";
  if (author.name) return author.name;
  if (author.host) return INBOX_HOST_NAMES[author.host] ?? author.host;
  return "An agent";
}

/** A message or reply. A thread is its root message's id. */
export interface InboxMessage {
  id: string;
  project_id: string;
  thread_id: string;
  reply_to: string | null;
  author: InboxAuthor;
  /** Set on a thread's root: the agent's subject, or one derived from the body. */
  subject: string | null;
  /** Markdown, as sent. */
  body: string;
  created_at: string;
  /** On a thread's root: when the thread was resolved, or null while open. */
  resolved_at: string | null;
  /** The sender's idempotency key, when one was given. */
  idempotency_key: string | null;
  /**
   * The `thread` name the agent sent this message with (send_message's
   * `thread`), else absent or null. On a root it is the thread's name: a
   * named thread is joined by name across sessions; an unnamed root is its
   * session's default thread. Added after step 1: older records lack it.
   */
  thread_name?: string | null;
  /**
   * On a root: the event-log seq up to which the person has looked at the
   * thread (the window's "seen"). Agent messages after it are "New since you
   * looked". Absent until the first look.
   */
  person_seen_seq?: number | null;
  /**
   * On a root: the person's Mark read, the event-log seq when they pressed it
   * and when. While no message but a set-aside note (`set_aside`) came after
   * it, the thread sits in Quiet without being closed; any other message
   * (an agent's, or the person's own reply) ends it without a write. Null
   * after Undo. Absent on records older than Mark read.
   */
  person_read_seq?: number | null;
  person_read_at?: string | null;
  /** On a root marked read: `person_seen_seq` before the Mark read (which counts as a look), for its Undo. */
  person_seen_before_read?: number | null;
  /**
   * On a person's set-aside note: the questions (`<message id>/<key>`) a
   * Mark read told the asking agent not to wait on. Written once per
   * question, after the Undo window, as a reply to the message that asked.
   * Absent on every other message.
   */
  set_aside?: string[];
  /**
   * On a person's reopened note: the questions an Undo of Mark read opened
   * again after a set-aside note had named them. Absent on every other message.
   */
  reopened?: string[];
  /**
   * On the note that carries a 👍 Looks good to the agent (amended
   * 2026-10-16): the agent message the person marked. Written once the
   * ack's Undo window passed (its body is `inboxAckLine`), as a reply to
   * that message, and delivered like any reply (the wake, wait_for_reply's
   * `acknowledged`) while the ack still names it (`InboxAck.note_id`). The
   * window and read_thread do not list it: the ack on the message says it.
   * Absent on every other message.
   */
  ack_of?: string;
  /**
   * On a root: the seq up to which the asking agent has read the person's
   * replies (wait_for_reply returned one, or read_thread read the thread),
   * and when. A Sent row moves to Quiet once its reply is checked.
   */
  agent_checked_seq?: number | null;
  agent_checked_at?: string | null;
  /**
   * The files an agent attached (send_message's `attachments`), recorded at
   * send time and read only by their ids (see inbox-attachments.ts). Added in
   * step 2: older records lack it.
   */
  attachments?: InboxAttachment[];
  /**
   * On an agent's message: the images its body shows, captured as files of
   * the thread (`InboxInlineImage`), in the order the body shows them. Written
   * when the message lands, or, for a message sent before images were
   * captured, the first time its thread is read (each record then marked
   * `captured: "on_open"`). Present (possibly empty) once capture ran; absent
   * on a message whose body shows no local image, and on older records.
   */
  inline_images?: InboxInlineImage[];
  /**
   * On a person's reply: it reached the asking agent's session as a turn
   * through an agent connection (the Claude Code mod), and when. Absent until
   * then; a reply the agent read through the MCP has none. "Replied" is not
   * stored: it is the asking session's next message in the thread. Added in
   * step 6: older records lack it.
   */
  delivery?: InboxDelivery | null;
  /**
   * On a person's reply or message not yet delivered: the person pressed
   * Send now in the Inbox, and when. The session's connection then delivers
   * it at once, into the running turn when one runs, instead of waiting for
   * the session to go idle (the bridge command's `now`). Absent otherwise
   * and on older records.
   */
  deliver_now_at?: string | null;
  /**
   * A guided review this message carries (submit_guide, PLAN step 5): the
   * snapshot is a content-addressed blob, `inbox/blobs/<sha256>`. Absent on
   * every other message and on records older than step 5.
   */
  guide?: InboxGuideRef | null;
  /**
   * On a message carrying a guide: the person's reviewed tick per section, as
   * the window's guide viewer last saved it (the record's 4.2, "kept with the
   * thread"). Absent until the first tick; the snapshot's own ticks apply then.
   */
  guide_reviewed?: boolean[] | null;
  /**
   * On a person's New message (plan step 8): the live agent session it is
   * addressed to. Such a message answers nothing (`reply_to` null) and is
   * delivered to that session as a turn, like a reply. Also on a person's
   * reply (`reply_to` set) when the session that asked had ended and the
   * person chose another live session to take it: that session alone is
   * handed it. Absent on every other message and on records older than step 8.
   */
  to?: InboxAddressee | null;
  /**
   * On an agent's message: the realpath of the `project_path` it was sent
   * from, when that is a folder inside the project other than its root.
   * Relative image paths in the body start there (#1813); absent, they start
   * at the project root. Added after step 8: older records lack it.
   */
  base_path?: string | null;
  /**
   * On an agent's message: it was sent through a connection that wakes its
   * session with the person's reply (the Claude Code mod, Pi, OpenCode 2;
   * `INBOX_WAKES_META_KEY`). Only such a session can be said to have ended
   * when it stops polling; an MCP-only agent or OpenCode 1 never polls, so
   * the window never calls it ended. Absent otherwise and on older records.
   */
  wakes?: boolean;
  /**
   * On an agent's message: the earlier questions it said it supersedes
   * (send_message's `supersedes`, as sent: `<message id>` for every open
   * question of that message, or `<message id>/<key>` for one). The question
   * records carry the result (`InboxQuestionRecord.superseded_by`); this is
   * what the agent asked for, so a retry with another list is refused. Absent
   * when it superseded nothing through the argument (a `Replaces:` line rides
   * the body). Added for replaced questions: older records lack it.
   */
  supersedes?: string[];
  /**
   * On a thread's root whose subject the agent did not give: the question
   * (`<message id>/<key>`) the subject was derived from, so the thread's
   * subject follows that question's `superseded_by` chain. Null when the
   * subject was the agent's own or came from the body's first line (it never
   * changes). Absent on records older than replaced questions: then a subject
   * equal to the root's first question's prompt counts as derived from it.
   */
  subject_question?: string | null;
  /**
   * On a thread's root the person wrote (compose: "send a new message to a
   * connected agent"): the thread was started by the person, addressed to
   * one live agent session (`to`), and is no session's default thread. The
   * agent's answer lands in it by `reply_to`. Absent on every other message.
   */
  started_by_person?: true;
  /**
   * On the root of a thread the person started: who gave it its name, the
   * thread chip (approval "inbox-agent-names-own-thread"). The person may name
   * it in compose; otherwise the first reply from a session that may name it
   * (`InboxStore.canNameThread`) carrying a valid `thread` names it, once, and
   * the root is written again with the name and this field. Absent while the
   * thread has no name, and on every other message. A name set here is never
   * replaced, except compose's suggestion (`kind: "auto"`), which the first
   * agent that may name the thread replaces.
   */
  named_by?: InboxThreadNamedBy;
  /**
   * On an agent's reply: the `thread` it carried, as given (trimmed), so a
   * retry with the same idempotency key and another `thread` is told apart.
   * Absent when it carried none, and on every other message.
   */
  reply_thread?: string;
  /**
   * On an agent's reply into a thread the person started that it could name:
   * what the naming came to (`InboxThreadNaming`), so a retry answers the
   * same. Absent everywhere else.
   */
  thread_naming?: InboxThreadNaming;
  /**
   * On an agent's message: the person's 👍 Looks good (design record
   * "inbox-acknowledge", approved 2026-10-15, amended 2026-10-16). The thread
   * is marked read; once the Undo window passes the Inbox sends it to the
   * agent (a note, `note_id`), delivered like a reply. Null after Undo.
   * Absent on every other message and on older records.
   */
  ack?: InboxAck | null;
}

/**
 * Who named a thread the person started (`InboxMessage.named_by`): the person
 * in compose (`thread_name` on the Send), compose's own suggestion the person
 * left as it was (`thread_name_auto: true`), or the agent whose reply named it.
 */
export type InboxThreadNamedBy =
  | { kind: "person"; at: string }
  /**
   * The name compose suggested from the message (`suggestPersonThreadName`)
   * and the person sent without editing it: shown like any name, but the
   * first agent that may name the thread (`InboxStore.canNameThread`) still
   * replaces it, once.
   */
  | { kind: "auto"; at: string }
  | {
      kind: "agent";
      host: string | null;
      session: string;
      /** The reply that carried the name. */
      message_id: string;
      at: string;
    };

/**
 * What a reply's naming of a thread the person started came to (approval
 * "inbox-agent-names-own-thread"), kept on the reply so a retry answers the
 * same: `named` (the thread's `thread_name` is now `name`); `refused`, with a
 * code (`invalid_thread_name`, or `thread_name_taken` when another open
 * thread of the project already has the name) and one sentence saying why;
 * `unnamed` when the reply gave no `thread`.
 */
export type InboxThreadNaming =
  | { status: "named"; name: string }
  | { status: "refused"; code: "invalid_thread_name" | "thread_name_taken"; reason: string }
  | { status: "unnamed" };

/**
 * The one line an agent is handed while a thread the person started still
 * has no name an agent gave and that agent may name it: in `wait_for_reply`
 * and `read_thread` beside `name_this_thread: true`. The wake of the thread
 * (INBOX_NAME_THREAD_LINE in shared/inbox/connection.ts) carries the same ask.
 */
export const INBOX_NAME_THIS_THREAD_HINT =
  "Name this thread: pass `thread` (a few words saying what it is about) with your reply. The first name you give sets it, once.";

/** The one acknowledgment the window offers (plan review's 👍 says the same words). */
export const INBOX_ACK_LABEL = "Looks good";

/**
 * The person's 👍 on an agent message (`InboxMessage.ack`). The last line
 * wins, as for every record: settling and the agent's read are new snapshot
 * lines of the same message.
 */
export interface InboxAck {
  label: string;
  at: string;
  /** The Mark read this ack stands on (the root's `person_read_seq`): Move back on that read withdraws the ack. */
  read_seq: number | null;
  /** This ack made that Mark read (the thread was not read before), so its Undo undoes the read too. */
  made_read?: boolean;
  /**
   * Set once the Undo window passed with the ack standing (the seq of that
   * line, and when): agents see it from then on (read_thread, and
   * wait_for_reply's `acknowledged`). Null before.
   */
  settled_seq?: number | null;
  settled_at?: string | null;
  /**
   * The note that carries this 👍 to the agent (`InboxMessage.ack_of`),
   * written when it settled. The note is delivered only while the ack still
   * names it, so a 👍 taken back before its delivery never arrives. Absent on
   * acks settled before the amendment (they were never sent).
   */
  note_id?: string | null;
  /**
   * Set when the Undo window ended but the 👍 could no longer go: the person
   * wrote back after the message (`replied`) or the agent wrote again
   * (`wrote_again`) inside the window. No note is written and no agent sees
   * it; the window says it was not sent. Absent on every other ack.
   */
  not_sent?: "replied" | "wrote_again" | null;
  /** When an agent read it (read_thread, or wait_for_reply returned it). Null until then. */
  seen_at?: string | null;
  /**
   * The window's thread only (`GET /api/inbox/threads/:id`): when the 👍
   * reached the agent (its note delivered as a turn, or an agent read it),
   * else null. Never stored.
   */
  delivered_at?: string | null;
}

/**
 * What superseded a question (`InboxQuestionRecord.superseded_by`): the
 * agent's later message, and the question in it that replaces this one, or
 * null when that message asks nothing in its place ("No longer applies").
 */
export interface InboxSupersededBy {
  message_id: string;
  key: string | null;
}

/** The agent session a person's New message is addressed to (`InboxMessage.to`). */
export interface InboxAddressee {
  /** The connection's host, e.g. `claude-code`. */
  host: string;
  session: string;
}

/** How a person's reply or New message reached an agent session (`InboxMessage.delivery`). */
export interface InboxDelivery {
  state: "delivered";
  /** The connection's host, e.g. `claude-code`. */
  host: string;
  /** The session it was delivered to (the asking message's `author.session`, or the message's `to.session`). */
  session: string;
  at: string;
}

// ─────────────────────────────── Guided reviews (step 5) ───────────────────────────────

/**
 * What a message keeps about the guided review it carries: the blob holding
 * the snapshot (Plannotator's portable format, `@plannotator/core/guide-format`,
 * exactly as validated) and the facts the card and the row draw.
 */
export interface InboxGuideRef {
  /** sha256 (hex) of the snapshot JSON, the blob's name under `inbox/blobs/`. */
  sha256: string;
  /**
   * sha256 (hex) of what the agent sent (the guide and the patch, or the
   * snapshot, as given). A retry with the same idempotency_key compares this:
   * the built snapshot carries the time it was built, so its own hash differs.
   */
  input_sha256: string;
  /** The snapshot JSON's size in bytes. */
  bytes: number;
  title: string;
  sections: number;
  /** Files in the patch. */
  files: number;
  additions: number;
  deletions: number;
}

/** One choice as the wire serves it (Workspaces' `QuestionChoice`). */
export interface InboxQuestionChoice {
  label: string;
  description: string | null;
  recommended: boolean;
  settled: boolean;
}

/** The parsed facts of a question block, kept on its record. */
export interface InboxQuestionFacts {
  context: string | null;
  choices: InboxQuestionChoice[];
  /** Plannotator's older names per choice (core `aliases`), in choice order; never served. */
  aliases: (string[] | null)[];
  recommendation: string | null;
  suggested_text: string | null;
  /** 1-based line of the prompt in the message body (the export's `(line N)`). */
  line: number;
}

export interface InboxPicker {
  id: string;
  name: string | null;
}

/** The stored question: one per question block of an agent's message. */
export interface InboxQuestionRecord {
  /** `<message id>/<question key>`. */
  id: string;
  project_id: string;
  message_id: string;
  key: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  parsed: InboxQuestionFacts;
  decision_on_answer: boolean;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  answer: QuestionAnswer | null;
  revision: number;
  sent_revision: number;
  picked_by: InboxPicker | null;
  picked_at: string | null;
  sent_reply_id: string | null;
  decision_id: string | null;
  /**
   * The card's "Records a decision" switch, as the person set it. Absent
   * until they touch it: then a `Decision: when answered` question records
   * and any other does not (`inboxDecisionRecording`). Added in step 3.
   */
  decision_recording?: boolean;
  /** The decision card's words after Done; null or absent: the drafted words. Added in step 3. */
  decision_draft?: InboxDecisionDraft | null;
  /**
   * The agent superseded this question with a later message (send_message's
   * `supersedes`, or a `Replaces:` line in a newer block): it can no longer
   * be answered, and a pick saved on it is never sent. Absent or null while
   * it stands. Added for replaced questions: older records lack it.
   */
  superseded_by?: InboxSupersededBy | null;
  /**
   * The person's Mark read closed this question unanswered: it reads as
   * `closed` with a skip for its answer, and records no decision. `previous`
   * is the question as it was (a saved pick included), which Undo puts back.
   * Absent or null while it stands. Added for Mark read: older records lack it.
   */
  set_aside?: InboxQuestionSetAside | null;
}

/** A question Mark read closed (`InboxQuestionRecord.set_aside`). */
export interface InboxQuestionSetAside {
  at: string;
  /**
   * The Mark read that closed it: the root's `person_read_seq` then. Undo
   * reopens only the questions its own Mark read closed (owner ruling
   * 2026-10-12); one an earlier Mark read closed stays closed. Absent on
   * records older than the ruling, which match by `at` (the Mark read's
   * `person_read_at`).
   */
  read_seq?: number;
  previous: Pick<InboxQuestionRecord, "answer" | "revision" | "sent_revision" | "picked_by" | "picked_at">;
}

/**
 * The decision card's words as the person left them on Done. A null field
 * was not edited and keeps following the drafted words (the answer, and
 * "Asked by <agent>: <question>"), so a later pick still drafts anew.
 */
export interface InboxDecisionDraft {
  text: string | null;
  reason: string | null;
}

/**
 * Derived, never stored. `superseded`: the agent replaced or withdrew the
 * question (`superseded_by`); it wins over `closed`, so a resolved thread's
 * card still says what replaced it. `closed`: the thread is archived, or the
 * person's Mark read closed the question (`set_aside_at`).
 */
export type InboxQuestionState = "open" | "picked" | "sent" | "closed" | "superseded";

/**
 * A question as the window and the agents read it: Workspaces' `Question`
 * exactly (`asked_by_checked_at` omitted, as Workspaces omits it outside its
 * two comment lists), plus the Inbox's `message_id`.
 */
export interface InboxQuestion {
  key: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  context: string | null;
  choices: InboxQuestionChoice[];
  recommendation: string | null;
  suggested_text: string | null;
  decision_on_answer: boolean;
  stopped: string | null;
  holds_up: string[];
  asked_by_agent_id: string | null;
  orphaned: boolean;
  state: InboxQuestionState;
  answer: QuestionAnswer | null;
  revision: number;
  sent_revision: number;
  picked_by: InboxPicker | null;
  picked_at: string | null;
  sent_reply_id: string | null;
  decision_id: string | null;
  message_id: string;
  /** Whether Send records this answer as a decision (the card's switch, or its default). */
  decision_recording: boolean;
  /** The decision card's edited words, or null for the drafted ones. */
  decision_draft: InboxDecisionDraft | null;
  /** What superseded it (`state: "superseded"`), or null. */
  superseded_by: InboxSupersededBy | null;
  /**
   * When the person's Mark read closed it unanswered (`state: "closed"`,
   * answer a skip), or null. Absent from an older Inbox.
   */
  set_aside_at?: string | null;
}

/** Workspaces' `NotificationQuestionSummary`: a row's questions, summed. */
export interface InboxQuestionSummary {
  open: number;
  picked: number;
  stopped: boolean;
  holds_up: string[];
  prompt: string | null;
}

export interface InboxMessageWire extends InboxMessage {
  /** Omitted when the message asks no question (the Workspaces rule). */
  questions?: InboxQuestion[];
  /**
   * The seq of the message's first line in the event log. Rides only on
   * `GET /api/inbox/threads/:id` (the window's thread), is never stored and
   * is not on the MCP tools: with the root's `person_seen_seq` it tells the
   * window which messages are new since the person's last look, read BEFORE
   * the window records the next look. Absent from an older Inbox.
   */
  seq?: number;
  /**
   * On a person's reply, on `GET /api/inbox/threads/:id` only: how many of
   * the person's annotations (on attached files or a guided review's diffs)
   * that reply carried. Absent from an older Inbox.
   */
  sent_annotations?: number;
}

export interface InboxThreadSummary {
  thread_id: string;
  project_id: string;
  subject: string | null;
  author: InboxAuthor;
  created_at: string;
  last_at: string;
  last_author: InboxAuthor["kind"];
  message_count: number;
  resolved_at: string | null;
  questions: InboxQuestionSummary;
  /**
   * The last message is an agent's and the thread is open: it waits on the
   * person. The Inbox's own notes (`isInboxNote`) are read past, and it is
   * false while a Mark read stands (nothing waits on the person then).
   */
  waiting_on_person: boolean;
}

/** The list's sections, in the approved order (Workspaces' inbox model). */
export type InboxSectionId = "stopped" | "holding" | "waiting" | "new" | "sent" | "quiet";

export const INBOX_SECTIONS: readonly { readonly id: InboxSectionId; readonly label: string }[] = [
  { id: "stopped", label: "Stopped on you" },
  { id: "holding", label: "Holding up work" },
  { id: "waiting", label: "Waiting on you" },
  { id: "new", label: "New since you looked" },
  // Sent waits on the agent, not on the person: below what is new to them.
  { id: "sent", label: "Sent" },
  { id: "quiet", label: "Quiet" },
];

/**
 * One row of the list: a thread (owner ruling 2026-10-07, "a row is a
 * thread"), with its project as a label and a filter, placed in its section.
 */
export interface InboxListRow extends InboxThreadSummary {
  project: { id: string; name: string };
  /** The thread's name (send_message's `thread`), or null for a session's default thread. */
  thread_name: string | null;
  section: InboxSectionId;
  /** Waiting on the person or new to them: drawn bold. */
  unread: boolean;
  /** No question is open, some are picked and not sent: it waits only for Send. */
  answered_not_sent: boolean;
  /** When the oldest open question was asked, or null when none is open. */
  waiting_since: string | null;
  /**
   * Agent messages after the person's last look (a reply of theirs counts as
   * a look; the Inbox's own notes, `isInboxNote`, do not).
   */
  unseen: number;
  /**
   * The person's reply is the last message, the Inbox's own notes read past:
   * when, and when the agent read it (null until it has).
   */
  sent: {
    at: string;
    checked_at: string | null;
    /**
     * It goes to a session whose connection delivers it as a turn by itself
     * (the asking message came through a waking connection, or the person
     * addressed it to a live session): "Queued for <agent>", not "Saved for".
     * Absent from an older Inbox.
     */
    wakes?: boolean;
  } | null;
  /**
   * When the latest agent message arrived (`last_at` also moves on the
   * person's messages and the Inbox's notes). The window's held list counts
   * agent activity by it. Absent from an older Inbox.
   */
  last_agent_at?: string | null;
  /** A message in the thread carries a guided review: the row's "Guided review" mark. */
  guide: boolean;
  /**
   * On a thread the person started (`started_by_person`): the agent session
   * it is addressed to now (the root's `to`, which "Send to another session"
   * may change), so the row draws that agent's mark and "To <agent>". Absent
   * on every other thread and from an older Inbox.
   */
  addressee?: InboxAddressee | null;
  /**
   * When the person marked the thread read (Mark read), while it still holds:
   * no message but a set-aside note since. The row is Quiet. Null otherwise.
   * Absent from an older Inbox.
   */
  read_at?: string | null;
  /**
   * The person's 👍 on the latest agent message, while the Mark read it made
   * still holds: the row says "👍 Looks good" in place of "Read". Null
   * otherwise. Absent from an older Inbox.
   */
  ack?: { label: string; at: string } | null;
  /**
   * The thread is archived (resolved) and an agent wrote in it after the
   * archive line (a reply_to reply). Those later messages behave as an open
   * thread's (their questions live and answerable, a reply goes to them);
   * the thread stays resolved until the person acts. Derived from the log,
   * never stored. Absent from an older Inbox.
   */
  agent_after_archive?: boolean;
  /**
   * `agent_after_archive`, and something there still waits: an agent
   * message after the archive the person has not looked at, a live question
   * open or picked, or the person's reply after the archive the agent has not
   * read (not once a Mark read made after it stands: Mark read sends a
   * came-back thread back to the archive). The thread is back in the list,
   * placed as an open thread would be; once handled it returns to the archive
   * on its own. Derived. Absent from an older Inbox.
   */
  back_from_archive?: boolean;
}

export interface InboxListSection {
  id: InboxSectionId;
  label: string;
  threads: InboxListRow[];
}

/** Something in the thread waits on the person: a question, or news they have not looked at. */
export function inboxRowWaitsOnPerson(row: Pick<InboxListRow, "section" | "unseen" | "answered_not_sent">): boolean {
  return (
    row.section === "stopped" ||
    row.section === "holding" ||
    row.section === "waiting" ||
    (row.section === "new" && (row.unseen > 0 || row.answered_not_sent))
  );
}

/**
 * Mark read is offered on the thread (the list row's hover action, and each
 * thread a project's "Mark all as read" takes): something waits on the
 * person, and the thread is open or came back from the archive (Mark read
 * sends a came-back thread back to the archive).
 */
export function inboxRowOffersMarkRead(
  row: Pick<InboxListRow, "section" | "unseen" | "answered_not_sent" | "resolved_at" | "back_from_archive">,
): boolean {
  return (row.resolved_at === null || row.back_from_archive === true) && inboxRowWaitsOnPerson(row);
}

export interface InboxThread {
  thread_id: string;
  /**
   * `repo` rides only on `GET /api/inbox/threads/:id` and is never stored:
   * the project's `origin`, or null for a folder without one or until the
   * Inbox has resolved it. Absent from an older Inbox.
   */
  project: InboxProject & { repo?: InboxProjectRepo | null };
  subject: string | null;
  /** The thread's name, or null for a session's default thread. */
  thread_name: string | null;
  resolved_at: string | null;
  /**
   * The window's read only (`GET /api/inbox/threads/:id`): the seq of the
   * archive line of a resolved thread, null for an open one. A message whose
   * `seq` is after it arrived after the archive and behaves as an open
   * thread's. Absent from an older Inbox and from the MCP tools.
   */
  archive_seq?: number | null;
  messages: InboxMessageWire[];
}

// ─────────────────────────────── Decisions ───────────────────────────────

/**
 * A decision's lifecycle (Workspaces' `project_decisions.state`): current
 * holds; replaced points at its replacement; retired no longer holds.
 */
export type InboxDecisionState = "current" | "replaced" | "retired";

export interface InboxDecisionAgent {
  host: string | null;
  session: string | null;
  name: string | null;
}

/** Where a decision came from. */
export interface InboxDecisionSource {
  /**
   * `answer`: recorded at Send from the person's answer to a question;
   * `agent`: an agent's record_decision; `person`: the person wrote it (a
   * replacement on the Decisions page).
   */
  kind: "answer" | "agent" | "person";
  /** The answered question (`<message id>/<key>`), for `answer`. */
  question_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  /** The asking agent (`answer`) or the recording one (`agent`). */
  agent: InboxDecisionAgent | null;
}

/**
 * One standing decision in a project: Workspaces' decision fields (text,
 * reason, source, state, version, replaces_id, replacement_id), so a later
 * sync maps it. `version` counts changes to this record (a retire or a
 * replace bumps it; a stale version is refused); a replacement is a new
 * record at version 1 that names what it replaces.
 */
export interface InboxDecision {
  id: string;
  project_id: string;
  text: string;
  reason: string | null;
  source: InboxDecisionSource;
  state: InboxDecisionState;
  version: number;
  replaces_id: string | null;
  replacement_id: string | null;
  created_at: string;
  /** When the state last changed (a retire or a replace); null while it was never changed. */
  changed_at: string | null;
  /** record_decision's idempotency key, when one was given. */
  idempotency_key: string | null;
}

// ─────────────────────────────── Lines ───────────────────────────────

export type InboxRecordKind = "project" | "message" | "question" | "decision" | "annotation";

/** One line of the store: a full snapshot of one record. */
export type InboxLine =
  | { v: 1; seq: number; at: string; kind: "project"; id: string; record: InboxProject }
  | { v: 1; seq: number; at: string; kind: "message"; id: string; record: InboxMessage }
  | { v: 1; seq: number; at: string; kind: "question"; id: string; record: InboxQuestionRecord }
  | { v: 1; seq: number; at: string; kind: "decision"; id: string; record: InboxDecision }
  | { v: 1; seq: number; at: string; kind: "annotation"; id: string; record: InboxAnnotationRecord };

// ─────────────────────────────── Health ───────────────────────────────

export const INBOX_APP_ID = "plannotator-inbox";

export interface InboxHealth {
  ok: true;
  app: typeof INBOX_APP_ID;
  /** The running binary's version, or `dev` for a source run. */
  version: string;
  serverSession: string;
  pid: number;
  /**
   * The sidebar's update button (packages/server/inbox-updates.ts), or null.
   * `available` and `version` keep the older `{ available, version }` shape.
   */
  update: InboxUpdate | null;
  /** Whether a notification can reach the person now (additive; absent from an older Inbox). */
  notify_reach?: InboxNotifyReach;
}

/** What an Inbox window reports about its browser's notification permission for its own origin. */
export type InboxWindowPermission = 'granted' | 'default' | 'denied' | 'unsupported' | 'unknown';

/**
 * Whether a browser notification can reach the person now
 * (packages/server/inbox-windows.ts): notifications come from an open Inbox
 * tab, so with none open, or none the browser lets notify, nothing reaches
 * them. `windows`: Inbox tabs holding an event stream; `allowed`: those whose
 * browser reported `granted`; `allowed_origins`: their addresses.
 */
export interface InboxNotifyReach {
  /** The Settings switch (config.json `inboxNotifications.enabled`). */
  enabled: boolean;
  windows: number;
  allowed: number;
  allowed_origins: string[];
}

/** The Inbox's update control: what the button says and does. */
export interface InboxUpdate {
  available: true;
  /**
   * `available`: a newer release exists, nothing installed yet. `updating`:
   * the install script runs. `ready`: a different binary is on disk (restart
   * to update). `failed`: an install the person started exited non-zero.
   */
  state: "available" | "updating" | "ready" | "failed";
  /** The version the button names. */
  version: string;
  /** The version this Inbox runs. */
  current: string;
  /** `script`: Update now runs the install script. `copy`: the binary is not the script's; the dialog shows the command. */
  action: "script" | "copy";
  releaseUrl: string;
  publishedAt?: string;
}

export function isInboxHealth(value: unknown): value is InboxHealth {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === true &&
    v.app === INBOX_APP_ID &&
    typeof v.version === "string" &&
    typeof v.serverSession === "string" &&
    typeof v.pid === "number"
  );
}

/**
 * The question sound (config.json `inboxSound`, through GET and POST
 * /api/inbox/settings): on unless turned off, one volume for every device.
 */
export interface InboxSoundSettings {
  enabled: boolean;
  /** 10 to 100; the slider has no 0, because the switch is how the sound goes off. */
  volume: number;
  /** The version the one-time "The Inbox can ring now" dialog was shown for (or a fresh install was marked with); null while never. */
  dialog_shown_for: string | null;
  /** The one-time dialog waits for a page on this computer to claim it (POST /api/inbox/sound/dialog). Absent from an Inbox before it. */
  dialog_due?: boolean;
}

export const INBOX_SOUND_DEFAULT_VOLUME = 60;
export const INBOX_SOUND_MIN_VOLUME = 10;
export const INBOX_SOUND_MAX_VOLUME = 100;

/** A volume the Inbox keeps: a whole number from 10 to 100. */
export function isInboxSoundVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= INBOX_SOUND_MIN_VOLUME && value <= INBOX_SOUND_MAX_VOLUME;
}

/**
 * The agents the Inbox connects itself to on `plannotator inbox` (the
 * approved "inbox-agent-awareness" design; packages/server/inbox-agents.ts).
 * Terminal agents and the Claude desktop app; editors keep their one-click
 * link or snippet in Settings and are never written to automatically.
 */
export type InboxAgentId =
  | "claude-code"
  | "codex"
  | "gemini"
  | "cursor"
  | "windsurf"
  | "amp"
  | "cline"
  | "kiro"
  | "pi"
  | "opencode"
  | "claude-app";

export const INBOX_AGENT_IDS: readonly InboxAgentId[] = [
  "claude-code",
  "codex",
  "gemini",
  "cursor",
  "windsurf",
  "amp",
  "cline",
  "kiro",
  "pi",
  "opencode",
  "claude-app",
];

export const INBOX_AGENT_LABELS: Readonly<Record<InboxAgentId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  windsurf: "Windsurf / Devin",
  amp: "Amp",
  cline: "Cline",
  kiro: "Kiro",
  pi: "Pi",
  opencode: "OpenCode",
  "claude-app": "Claude app",
};

/** "Codex", "Codex and Amp", "Codex, Amp and Pi". */
export function inboxAgentList(ids: readonly InboxAgentId[]): string {
  const names = ids.map((id) => INBOX_AGENT_LABELS[id]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What one `plannotator inbox` run did to the agents on this computer. */
export interface InboxConnectReport {
  at: string;
  /** The first run that connected anything on this computer; later runs say "new on this computer". */
  first: boolean;
  /** Skipped as a whole: `PLANNOTATOR_INBOX_CONNECT=0`, or a test sandbox whose home is the real one. */
  skipped?: "env" | "sandbox";
  /** Connected by this run. */
  added: InboxAgentId[];
  /** Already reached the Inbox before this run (found, or connected earlier). */
  already: InboxAgentId[];
  /** Could not be connected; nothing was changed. Tried again at the next run. */
  failed: { agent: InboxAgentId; reason: string; path: string | null }[];
  /** Have a `plannotator-inbox` entry that runs something else; left alone. */
  foreign: { agent: InboxAgentId; path: string | null }[];
  /** Found, but only a person can connect them (no CLI on PATH, a config file Plannotator does not edit). */
  manual: InboxAgentId[];
  /** Why each manual agent needs a person, said once per reason (the terminal prints these). */
  manual_why?: { agent: InboxAgentId; why: string }[];
  /** Did not finish within the time limits; tried again at the next run. */
  unfinished: InboxAgentId[];
  /** Claude Code's plugin gives it the `plannotator_inbox` tool already. */
  claude_code: boolean;
}

/** The agents whose own instructions file can carry the Inbox note (packages/server/inbox-agent-notes.ts). */
export type InboxNoteAgentId = "claude-code" | "codex" | "opencode" | "pi" | "gemini";
export const INBOX_NOTE_AGENT_IDS: readonly InboxNoteAgentId[] = ["claude-code", "codex", "gemini", "pi", "opencode"];

/**
 * Where an agent's note would go and how it stands:
 *  - absent: no note; `create` says whether adding it creates the file.
 *  - added: the note Plannotator wrote is there, untouched.
 *  - edited: the note is there but the person changed it; Plannotator never updates it.
 *  - damaged: the markers are broken (one, several, or out of order); nothing is written.
 *  - refused: the file cannot be edited (not a regular file, over 1 MiB, not UTF-8, unreadable).
 *  - unavailable: no file to add to (OpenCode's AGENTS.md does not exist, and Plannotator never creates it).
 */
export interface InboxAgentNoteStatus {
  agent: InboxNoteAgentId;
  /** The file, `~` for the home folder. */
  path: string | null;
  /** The file is a link; `target` is where it leads (shown). */
  target: string | null;
  state: "absent" | "added" | "edited" | "damaged" | "refused" | "unavailable";
  /** Adding it creates the file. */
  create: boolean;
  /** Plannotator created the file (removing the note deletes it when nothing else is left). */
  created: boolean;
  /** Why it is refused, damaged or unavailable. */
  reason: string | null;
  /** Other agents whose note lives in the same file (a link to one shared file): one section, kept while any of them has it on. */
  shared_with?: InboxNoteAgentId[];
}

/** One agent in `GET /api/inbox/agents` (Settings → Agents and the first-open card). */
export interface InboxAgentRow {
  id: InboxAgentId;
  label: string;
  /** Found on this computer (its command on PATH, its folder, Plannotator's plugin). */
  detected: boolean;
  reach: {
    kind: "tool" | "mcp" | "manual" | "none";
    on: boolean;
    state: "connected" | "off" | "removed" | "foreign" | "not_connected" | "manual" | "unreadable";
    path: string | null;
    /** PLANNOTATOR_INBOX_TOOL decides it. */
    locked: boolean;
    reason: string | null;
  };
  /**
   * Claude Code, Pi and OpenCode only: their `plannotator_inbox` tool switch (`inboxTool`), shown whether or not the agent was found.
   * `chosen_off`: config.json turns it off by name (not the host's default), so the first-run screen never offers turning it on.
   * `mod_off` (Claude Code): Plannotator's Claude Code mod is off (PLANNOTATOR_CLAUDE_MOD / claudeCodeMod), so there is no tool whatever inboxTool says.
   */
  tool?: { on: boolean; locked: boolean; chosen_off?: boolean; mod_off?: boolean } | null;
  /** Claude Code, Pi and OpenCode only. `needs_tool`: the tool is off, so there is no reminder. */
  reminder: { on: boolean; locked: boolean; needs_tool: boolean } | null;
  note: InboxAgentNoteStatus | null;
  /**
   * Claude Code, Pi and OpenCode only: whether Plannotator's own plugin or
   * extension is installed (Claude Code's plugin enabled, Pi's settings
   * `packages`, OpenCode's global `plugin`/`plugins`). Absent from an older
   * Inbox; null for every other agent. `disabled` (Claude Code): installed and
   * turned off by name (`claude plugin disable`), the person's choice;
   * `managed`, turned off by managed (enterprise) settings.
   * `generation` (OpenCode): the version on PATH (`opencode2`: 2, `opencode`
   * alone: 1), for the plugin line that version reads.
   */
  plugin?: { installed: boolean; disabled?: boolean; managed?: boolean; generation?: "1" | "2" } | null;
}

export interface InboxAgentsModel {
  agents: InboxAgentRow[];
  last_report: (InboxConnectReport & { seen?: boolean }) | null;
  connecting: boolean;
  /** PLANNOTATOR_INBOX_CONNECT turns the automatic step off. */
  connect_env_off: boolean;
  /** PLANNOTATOR_INBOX_TOOL's value when set. */
  tool_env: boolean | null;
  /** PLANNOTATOR_INBOX_NOTES=0: no note offer, and note rows only for a note already written (it can be turned off, not added). */
  notes_env_off?: boolean;
  /** The note question was answered at least once. */
  notes_offered: boolean;
  /** The agents the note question was asked about: each is asked once (absent from an Inbox of 0.28.18 or older, which asked once in all). */
  notes_asked?: InboxNoteAgentId[];
  /** The exact block a note writes, markers included. */
  note_text: string;
  /** A switch's refusal, after POST /api/inbox/agents. */
  error?: string | null;
}

/** The hosts whose every request carries the `plannotator_inbox` tool in full once it is on (Claude Code defers it behind tool search). */
export type InboxToolCostHost = "pi" | "opencode";

/**
 * What turning the Inbox tool on adds to every request on Pi and OpenCode 2,
 * measured on the real hosts: apps/pi-extension/inbox.test.ts and
 * apps/opencode-plugin/inbox-v2.test.ts read the request the host sends a
 * scripted model and fail when the tool's entry drifts more than 5% from
 * `bytes`. Tokens depend on the model's tokenizer: the same entry counts
 * 1,661 with o200k_base (GPT-4o and later), and Claude's tokenizer counts
 * JSON and code higher, so `tokens` is a rounded, deliberately high estimate,
 * stated as "roughly". The window states both (`inboxToolCostText`: the
 * first-run screen, Settings → Agents), as does `plannotator inbox --help`.
 * Before the long field descriptions were shortened
 * (INBOX_AGENT_FIELD_DESCRIPTIONS) the entry was 11,736 bytes (2,796 tokens
 * with o200k_base) on both hosts.
 */
export const INBOX_TOOL_COST: Readonly<Record<InboxToolCostHost, { bytes: number; tokens: number }>> = {
  pi: { bytes: 7058, tokens: 2000 },
  opencode: { bytes: 7058, tokens: 2000 },
};

/** "about 7 KB, roughly 2,000 tokens" for a host's measured cost. */
export function inboxToolCostText(host: InboxToolCostHost): string {
  const cost = INBOX_TOOL_COST[host];
  return `about ${Math.round(cost.bytes / 1000)} KB, roughly ${cost.tokens.toLocaleString("en-US")} tokens`;
}

/** "Codex, Gemini CLI and Pi" for note agents. */
export function inboxNoteAgentList(ids: readonly InboxNoteAgentId[]): string {
  return inboxAgentList(ids);
}

// ─────────────── Compose: a new thread the person starts with a live agent ───────────────

/**
 * A file the person uploaded from the window for a thread they start, not
 * sent yet (`POST /api/inbox/uploads`). At send it becomes an
 * `InboxAttachment`; a draft names it by `upload_id`.
 */
export interface InboxUpload {
  upload_id: string;
  name: string;
  size: number;
  kind: InboxAttachmentKind;
  sha256: string;
  created_at: string;
  media_type?: string;
  width?: number;
  height?: number;
}

/** The session a draft was written for, with enough to name it after it has ended. */
export interface InboxDraftTo {
  host: string;
  session: string;
  project_root: string | null;
  project_name: string | null;
  started_at: string | null;
}

/**
 * A message the person started and did not send (`inbox/drafts/<id>.json`):
 * never in the event log, so never seen by agents, phones or search. A draft
 * never sends itself and is never re-addressed on its own.
 */
export interface InboxDraft {
  v: 1;
  id: string;
  created_at: string;
  updated_at: string;
  body: string;
  to: InboxDraftTo | null;
  /** The project it was written in (the chosen session's, or the one open in the list). */
  project: { id: string | null; root: string; name: string } | null;
  files: InboxUpload[];
  /**
   * The thread's name the person typed in compose (the chip), as typed.
   * Absent while the chip follows the message (compose's suggestion, worked
   * out again from the body when the draft opens).
   */
  thread_name?: string;
}

/** A draft's chip: its chosen session is live, has ended, or none was chosen. */
export type InboxDraftStatus = "live" | "ended" | "none";

/** One live session as compose lists it (`GET /api/inbox/sessions`). */
export interface InboxComposeSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  busy: boolean | null;
  idle_since: string | null;
  /** The thread it last wrote in, or null when it has not written in the Inbox. */
  last_thread: { id: string; subject: string | null; at: string } | null;
}

/** Live sessions grouped by the project they work in; `id` null for a folder the Inbox has not seen yet. */
export interface InboxComposeProject {
  project: { id: string | null; name: string; root: string };
  sessions: InboxComposeSession[];
}
