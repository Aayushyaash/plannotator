/**
 * Where the person's latest sent item is: the one rule behind the line under
 * their reply in the thread (packages/inbox/deliveryLine.ts) and the glyph on
 * the list row (`InboxListRow.delivery`, approval "inbox-row-delivery",
 * "Ticks"), so a row and its thread never disagree. Pure, browser-safe.
 */

/** delivered ✓✓, not delivered (a warning), saved ✓ (an agent reads it later), queued (a clock), sending (dots). */
export type InboxDeliveryState = "delivered" | "undelivered" | "saved" | "queued" | "sending";

/**
 * Which case of the rule decided the state, so a client words it exactly as
 * the thread does: `delivered`, `undelivered` (the addressed session stopped
 * before it took it), `ended` (saved: the session that asked has ended),
 * `reads` (saved: an agent that reads the thread), `sending_now` (Send now
 * pressed), `working` (queued: its session is in a turn), `idle` (sending:
 * the session is idle, the turn goes now), `away` (queued: its session does
 * not poll now), `next_turn` (queued: the Inbox does not know the session's
 * state), `ack_pending` (a 👍 inside its Undo window).
 */
export type InboxDeliveryReason =
  | "delivered"
  | "undelivered"
  | "ended"
  | "reads"
  | "sending_now"
  | "working"
  | "idle"
  | "away"
  | "next_turn"
  | "ack_pending";

/** How the session the item goes to is connected now: the fields the rule reads. */
export interface InboxDeliveryConnection {
  /** A turn runs now; null when the connection does not say. */
  busy: boolean | null;
  /** Its connection can deliver into a running turn. */
  send_now: boolean;
}

export interface InboxDeliveryInput {
  /** It reached the session (or an agent read it). */
  delivered: boolean;
  /** A message addressed to a session that stopped before it took it (after the asker grace). */
  undelivered: boolean;
  /** The session that asked has ended (a reply). */
  askerEnded: boolean;
  /** The session it goes to is woken by its connection. */
  wakes: boolean;
  /** The person pressed Send now (`deliver_now_at`). */
  sendingNow: boolean;
  /** Undefined: not known (not read yet, an older Inbox); null: it does not poll now. */
  connection: InboxDeliveryConnection | null | undefined;
}

export interface InboxDeliveryDecision {
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  /** Offer Send now: the session works and its connection can take the item mid-turn. */
  sendNow: boolean;
}

export function inboxDeliveryState(input: InboxDeliveryInput): InboxDeliveryDecision {
  const no = { sendNow: false };
  if (input.delivered) return { state: "delivered", reason: "delivered", ...no };
  if (input.undelivered) return { state: "undelivered", reason: "undelivered", ...no };
  if (input.askerEnded) return { state: "saved", reason: "ended", ...no };
  if (!input.wakes) return { state: "saved", reason: "reads", ...no };
  const connection = input.connection;
  // Pressed, and the session can take it now. While it cannot (its own Ask this session question holds
  // it), the item waits for the turn to end: it reads as queued.
  if (input.sendingNow && !(connection?.busy === true && !connection.send_now)) return { state: "sending", reason: "sending_now", ...no };
  if (connection?.busy === true) return { state: "queued", reason: "working", sendNow: connection.send_now && !input.sendingNow };
  if (connection?.busy === false) return { state: "sending", reason: "idle", ...no };
  if (connection === null) return { state: "queued", reason: "away", ...no };
  return { state: "queued", reason: "next_turn", ...no };
}

/** The question states a message holds, as the asking rule reads them. */
type AskingQuestionState = "open" | "picked" | "sent" | "closed" | "superseded";

/**
 * Whether a Send skips the questions it leaves unanswered, by default (no
 * choice made on the chip): only when it carries an answer, i.e. some
 * question in the thread holds a saved pick not yet sent.
 */
export function inboxDefaultSkip<M>(messages: readonly M[], statesOf: (message: M) => readonly AskingQuestionState[]): boolean {
  return messages.some((message) => statesOf(message).includes("picked"));
}

/**
 * The agent message whose session a Send with nothing riding on the latest
 * message reaches (the thread's `askingSessionOf` without words or files):
 * the last agent message a pick answers or, when the Send skips (`skip`),
 * an open question it skips; with none, the latest agent message. Null when
 * no agent wrote. One rule for the thread's "the session that asked" and the
 * list row's delivery, so the two name the same session.
 */
export function inboxAskingMessage<M extends { author: { kind: string } }>(
  messages: readonly M[],
  statesOf: (message: M) => readonly AskingQuestionState[],
  skip: boolean,
): M | null {
  let latest: M | null = null;
  let answered: M | null = null;
  for (const message of messages) {
    if (message.author.kind !== "agent") continue;
    latest = message;
    if (statesOf(message).some((state) => state === "picked" || (skip && state === "open"))) answered = message;
  }
  return answered ?? latest;
}

/**
 * The delivery of the person's latest sent item in a thread, on its list row
 * (`InboxListRow.delivery`): a reply, a message the person addressed to a
 * session (a thread they started, a New message, a reply sent to another
 * session), or a 👍 Looks good the Inbox sent through. Computed by the
 * server from the store and the live sessions with `inboxDeliveryState`.
 */
export interface InboxRowDelivery {
  kind: "reply" | "message" | "ack";
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  /** Send now is offered in the thread (the row never offers it). */
  send_now: boolean;
  /** The person's message (a reply or message), or the agent message the 👍 is on. */
  message_id: string;
  /** Delivered at (`delivered`), else null. */
  at: string | null;
  /** Whom it goes to: the host of the session (null for an agent without one). */
  host: string | null;
  /** An MCP agent's own name, when the thread names it by that. */
  name: string | null;
  /** It went to another session of the asker's own host ("Claude Code (another session)"). */
  another_session?: boolean;
  /**
   * `reason: "ended"`: the agent of the session that asked and has ended
   * (`inboxAskingMessage`), which the line names ("Saved for <it>. The
   * session that asked has ended…"). Absent otherwise.
   */
  asking?: { host: string | null; name: string | null };
}
