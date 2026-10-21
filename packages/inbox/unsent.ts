/**
 * The reply a person is writing that a restart (or a reload) would lose, for
 * the update control's restart guard and the page's beforeunload: restarting
 * the Inbox reloads the page. The words are kept as a reply draft as they are
 * typed (replyDraft.ts), and picks and comments are saved at once, so what a
 * restart loses is files pasted into the box, and words not saved yet (a save
 * waiting or on its way, or words a conflict left unsaved). The open thread
 * reports its subject and its pasted files; the guard reads it.
 */
import { replyDraftUnsaved } from './replyDraft';

let open: { subject: string; files: boolean } | null = null;

/** The open thread's reply box: its subject and whether it holds pasted files, else null (no box open). */
export function reportUnsentReply(value: { subject: string; files: boolean } | null): void {
  open = value;
}

/** What a restart would lose, by the thread's subject, else null. */
export function unsentReply(): { subject: string } | null {
  if (open?.files) return { subject: open.subject };
  if (replyDraftUnsaved()) return { subject: open?.subject ?? 'a reply' };
  return null;
}
