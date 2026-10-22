/**
 * Open questions inside one thread (approval "inbox-thread-open-questions",
 * option A, 2026-10-22): the "N open questions" button in the thread's foot
 * and the short list it opens. Pure: which questions are listed, how the
 * list names them, and when the button is shown at all.
 *
 * Listed: every question of a live agent message (not one an archive closed)
 * that waits on the person: open, or picked and not sent. Replaced questions
 * (`superseded`) are left out and counted apart; action items are not
 * questions and are left out. Answering stays on the real card: the list only
 * takes the person there.
 */

import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind } from '@plannotator/core/inbox-types';
import { formatCount } from './format';

/** One row of the list. */
export interface OpenQuestion {
  /** `<message id>/<key>`. */
  id: string;
  messageId: string;
  key: string;
  prompt: string;
  /** The message's time (ISO), which the row names. */
  at: string;
  /** Picked and not sent: the row reads "Draft · <pick>". */
  picked: boolean;
  question: InboxQuestion;
}

/** A question the person can still answer: not an action item, not a kind this window does not know. */
const isQuestion = (q: InboxQuestion) => {
  const kind = readInboxQuestionKind(q.kind);
  return kind !== 'unknown' && kind !== 'action';
};

/** Open, or picked and not sent. */
const waits = (q: InboxQuestion) => q.state === 'open' || q.state === 'picked';

/**
 * The thread's open questions, in thread order, and how many replaced ones
 * were left out. `live` says which messages still take answers.
 */
export function threadOpenQuestions(
  messages: readonly InboxMessageWire[],
  live: (message: InboxMessageWire) => boolean = () => true,
): { questions: OpenQuestion[]; replaced: number } {
  const questions: OpenQuestion[] = [];
  let replaced = 0;
  for (const m of messages) {
    if (m.author.kind !== 'agent' || !live(m)) continue;
    for (const q of m.questions ?? []) {
      if (!isQuestion(q)) continue;
      if (q.state === 'superseded') {
        replaced += 1;
        continue;
      }
      if (!waits(q)) continue;
      questions.push({ id: `${m.id}/${q.key}`, messageId: m.id, key: q.key, prompt: q.prompt, at: m.created_at, picked: q.state === 'picked' && q.answer != null, question: q });
    }
  }
  return { questions, replaced };
}

/**
 * Whether the button is shown. Two or more open questions: always. One:
 * only where it adds something, i.e. when its card may be out of sight: its
 * message is folded (or hidden in the middle fold), or the thread is
 * long (`OPEN_QUESTIONS_LONG_THREAD` messages or more, where a card scrolls
 * off and the fold starts folding).
 * One open question in a short, unfolded thread sits on screen with the
 * thread's own controls, so the button would only repeat it.
 */
export const OPEN_QUESTIONS_LONG_THREAD = 4;

export function openQuestionsShown(questions: readonly OpenQuestion[], options: { messageCount: number; folded: (messageId: string) => boolean }): boolean {
  if (questions.length === 0) return false;
  if (questions.length >= 2) return true;
  const only = questions[0]!;
  return options.folded(only.messageId) || options.messageCount >= OPEN_QUESTIONS_LONG_THREAD;
}

/** "5 open questions" / "1 open question". */
export function openQuestionsLabel(n: number): string {
  return `${formatCount(n)} open question${n === 1 ? '' : 's'}`;
}

/** The list's heading: "5 open questions in this thread". */
export function openQuestionsHeading(n: number): string {
  return `${openQuestionsLabel(n)} in this thread`;
}

/** The muted line beside the heading: "1 in your draft · 1 replaced, left out" (nothing when both are zero). */
export function openQuestionsSub(questions: readonly OpenQuestion[], replaced: number): string {
  const drafts = questions.filter((q) => q.picked).length;
  return [drafts > 0 ? `${formatCount(drafts)} in your draft` : '', replaced > 0 ? `${formatCount(replaced)} replaced, left out` : ''].filter(Boolean).join(' · ');
}

/** Where a question's card sits, as a row says it. */
export type OpenQuestionPlace = 'folded' | 'above' | 'below';

export function openQuestionPlaceWords(place: OpenQuestionPlace): string {
  return place === 'folded' ? 'in a folded message' : place;
}

/**
 * Above or below, from the card's middle against the middle of the thread's
 * view: a card half in view still reads where the most of it is, and the
 * list never needs a fourth word.
 */
export function placeOf(card: { top: number; bottom: number } | null, view: { top: number; bottom: number }): 'above' | 'below' {
  if (!card) return 'below';
  return (card.top + card.bottom) / 2 < (view.top + view.bottom) / 2 ? 'above' : 'below';
}

/** The state a row shows: the draft pick first, else Stopped, else Holds up, else nothing. */
export type OpenQuestionState = { kind: 'draft' } | { kind: 'stopped' } | { kind: 'holds'; count: number } | null;

export function openQuestionState(q: OpenQuestion): OpenQuestionState {
  if (q.picked) return { kind: 'draft' };
  if (q.question.stopped) return { kind: 'stopped' };
  if (q.question.holds_up.length > 0) return { kind: 'holds', count: q.question.holds_up.length };
  return null;
}
