/**
 * The reply a person is writing that a restart would lose, for the update
 * control's restart guard: restarting the Inbox reloads the page. The words
 * are kept as a reply draft as they are typed (replyDraft.ts), and picks and
 * comments are saved at once, so only files pasted into the box are lost.
 * The open thread reports them; the guard reads it.
 */

let unsent: { subject: string } | null = null;

/** The open thread's reply box: its subject while it holds pasted files, else null. */
export function reportUnsentReply(value: { subject: string } | null): void {
  unsent = value;
}

export function unsentReply(): { subject: string } | null {
  return unsent;
}
