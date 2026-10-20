/**
 * "Draft" (approval "inbox-reply-drafts", variant Label): what the person has
 * not sent in a thread, said with Gmail's word wherever the window used to say
 * "Not sent". The row's count slot ("Draft · Your reply, 2 picks"), the soft
 * pill above the reply box ("Draft  Reply to … · Saved 4:43 PM · Discard"),
 * and the thread's foot ("Draft · 2 picks" before Send / Edit draft).
 */
import type { InboxRowUnsent } from '@plannotator/core/inbox-types';
import { shortTime } from '../format';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** What waits, in words: "Your reply, 2 picks, 1 comment" (`lead`: capitalized). */
export function unsentWords(unsent: { reply: boolean; picks: number; comments: number }, lead = true): string {
  const parts: string[] = [];
  if (unsent.reply) parts.push('your reply');
  if (unsent.picks > 0) parts.push(plural(unsent.picks, 'pick'));
  if (unsent.comments > 0) parts.push(plural(unsent.comments, 'comment'));
  const text = parts.join(', ');
  return lead ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** A row's `unsent`, as unsentWords takes it. */
export function rowUnsent(unsent: InboxRowUnsent): { reply: boolean; picks: number; comments: number } {
  return { reply: unsent.reply_at !== null, picks: unsent.picks, comments: unsent.comments };
}

/** The list row's count slot: "Draft · Your reply". */
export function DraftLabel({ unsent }: { unsent: InboxRowUnsent }) {
  return (
    <span className="ib-draft-l" data-draft-label="">
      <b>Draft</b> <span aria-hidden="true">·</span> <span>{unsentWords(rowUnsent(unsent))}</span>
    </span>
  );
}

/** Above the open reply box: the pill, whom it goes to, when it was saved, and Discard. */
export function DraftHead({ label, savedAt, onDiscard }: { label: string; savedAt: string | null; onDiscard: (() => void) | null }) {
  return (
    <div className="ib-reply-l ib-draft-head" data-draft-head="">
      {savedAt !== null && <span className="ib-draft-pill">Draft</span>} <span className="ib-draft-for" dir="auto">{label}</span>
      {savedAt !== null && (
        <>
          <span className="ib-sp" />
          <span className="ib-draft-saved" role="status">
            Saved {shortTime(savedAt)}
          </span>
          {onDiscard && (
            <button type="button" className="ib-draft-discard" data-draft-discard="" onClick={onDiscard}>
              Discard
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The thread's foot while the box is closed and something waits: "Draft · 2 picks". */
export function DraftFootNote({ unsent }: { unsent: { reply: boolean; picks: number; comments: number } }) {
  return (
    <span className="ib-draft-foot" data-draft-foot="">
      <span className="ib-draft-pill">Draft</span> <span className="ib-st">{unsentWords(unsent)}</span>
    </span>
  );
}
