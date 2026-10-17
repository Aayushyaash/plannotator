/**
 * The line under the person's last reply or message: where it is now.
 *
 * The owner's request (2026-10-16): "The message should be less deceiving.
 * It should say this message is queued up or something. And then maybe an
 * option just to send it immediately." A reply to a session whose connection
 * wakes it (the Claude Code mod, Pi, OpenCode 2) is delivered as a turn by
 * itself once the session is idle, so the line says what it waits for, from
 * what the Inbox knows about that session's connection right now (its poll's
 * `busy`), and offers Send now while the session works and its connection
 * can put the reply into the running turn (`send_now`). A reply to an agent
 * that only reads the thread (MCP, OpenCode 1) keeps the truthful "it sees
 * it when it next reads this thread". Pure: Thread.tsx draws it.
 */

/** How the session the message goes to is connected now (the sessions route's `asker.connection`). */
export interface RecipientConnection {
  busy: boolean | null;
  idle_since: string | null;
  send_now: boolean;
}

export type DeliveryLineState = 'delivered' | 'undelivered' | 'saved' | 'queued' | 'sending';

export interface DeliveryLine {
  state: DeliveryLineState;
  text: string;
  /** The asking session ended: a clock, not a check. */
  ended?: boolean;
  /** Offer Send now: the session works and its connection can take the reply mid-turn. */
  sendNow?: boolean;
}

export interface DeliveryLineInput {
  /** "Claude Code", "Pi (another session)". */
  name: string;
  /** Delivered (or read by the agent) at; null while it waits. */
  deliveredAt: string | null;
  /** Formats a time for the line ("5:12 PM"). */
  time: (iso: string) => string;
  /** The session it goes to is woken by its connection (a waking agent message, or a message addressed to a live session). */
  wakes: boolean;
  /** The person pressed Send now (`deliver_now_at`). */
  sendingNow: boolean;
  /**
   * That session's connection as the Inbox knows it now: undefined while not
   * read yet or from an older Inbox (no `connection`), null when it does not
   * poll now.
   */
  connection: RecipientConnection | null | undefined;
  /** The asking session ended (a reply), with the asker's name for the line. */
  askerEnded?: { name: string } | null;
  /** A message addressed to a session that stopped before it took it (compose). */
  undelivered?: { host: string } | null;
}

export function deliveryLine(input: DeliveryLineInput): DeliveryLine {
  const { name } = input;
  if (input.deliveredAt) return { state: 'delivered', text: `Delivered to ${name}, ${input.time(input.deliveredAt)}` };
  if (input.undelivered) {
    return { state: 'undelivered', text: `Not delivered. That ${input.undelivered.host} session stopped before it took this. If it is resumed, it still gets it.` };
  }
  if (input.askerEnded) {
    return {
      state: 'saved',
      ended: true,
      text: `Saved for ${input.askerEnded.name}. The session that asked has ended, so it waits here until an agent reads this thread.`,
    };
  }
  if (!input.wakes) return { state: 'saved', text: `Saved for ${name}. It sees it when it next reads this thread.` };
  const connection = input.connection;
  // Pressed, and the session can take it now. While it cannot (its own Ask this session question holds
  // it), the reply waits for the turn to end: it reads as queued.
  if (input.sendingNow && !(connection?.busy === true && !connection.send_now)) return { state: 'sending', text: `Sending to ${name} now…` };
  if (connection?.busy === true) {
    return { state: 'queued', text: `Queued · ${name} is working; it gets this when its turn ends.`, sendNow: connection.send_now && !input.sendingNow };
  }
  if (connection?.busy === false) return { state: 'sending', text: `Sending to ${name}…` };
  if (connection === null) return { state: 'queued', text: `Queued for ${name}; it gets this when its session is back.` };
  return { state: 'queued', text: `Queued for ${name}; it gets this as its next turn.` };
}

/** The Sent row's line in the list, which knows no connection: queued for a waking agent, saved otherwise. */
export function sentRowLine(name: string, wakes: boolean | undefined): string {
  return wakes === true ? `Queued for ${name}; it gets this as its next turn.` : `Saved for ${name}. It sees it when it next reads this thread.`;
}
