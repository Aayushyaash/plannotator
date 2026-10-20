/**
 * Re-ask (approval "inbox-reask", 2026-10-20): the person asks the agent
 * that asked for its questions still open in the thread again, together in
 * one new message, with fresh context. The agent's new message replaces the
 * old cards (`Replaces:` lines) or closes those that no longer apply
 * (`supersedes`); until then the old ones stay open.
 *
 * Pure: which sessions a Re-ask goes to, and the words around it. One note
 * per session (owner's rule 3): a thread where two sessions asked gets two.
 * Picks the person made and has not sent go with the note as answers
 * (owner's rule 2); only the rest are asked again.
 */

import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { agentName, plural } from './format';

/** One session's part of a Re-ask. */
export interface ReaskTarget {
  /**
   * `reask`: a note asking the session for its open questions again (its
   * unsent picks go with it). `picks`: the session has nothing open, only
   * picks not sent: a plain reply carries them as answers, so a Re-ask never
   * strands them.
   */
  kind: 'reask' | 'picks';
  /** The session's latest message with a question still open or picked: the note answers it. */
  message: InboxMessageWire;
  session: string | null;
  host: string | null;
  /** "Claude Code": the agent as the thread names it. */
  name: string;
  /** Open questions with no pick: asked again. */
  open: number;
  /** Picked and not sent: they go with the note (or the plain reply) as answers. */
  picked: number;
  /** For `picks`: one plain reply per message holding picks, as a Send carries them. */
  replies: { message: InboxMessageWire; questions: { key: string; revision: number }[] }[];
}

const isReaskNote = (m: InboxMessageWire): boolean => m.author.kind === 'person' && (m.reask?.length ?? 0) > 0;

/**
 * The sessions a Re-ask would go to now. A session is left out while a note
 * of its waits (rule 2a): no message after it from the session the note went
 * to (the note's `to` when the person sent it to another session because
 * this one ended, else this session), and a question it lists still open.
 * Once that session wrote, or nothing it lists is open, what is left can be
 * asked again. Also left out right after it
 * answered a note (every question it still has open sits in its one message
 * that answered the note), and when nothing of its waits. `live` says which
 * messages still take answers (not closed by an archive).
 */
export function reaskTargets(messages: readonly InboxMessageWire[], live: (message: InboxMessageWire) => boolean = () => true): ReaskTarget[] {
  const groups = new Map<string, InboxMessageWire[]>();
  for (const m of messages) {
    if (m.author.kind !== 'agent' || !live(m)) continue;
    // An agent that named no session: each message is its own.
    const key = m.author.session ? `${m.author.host ?? ''}\u0000${m.author.session}` : `\u0001${m.id}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const wroteAfter = (note: InboxMessageWire, by: { host: string | null; session: string | null }) => {
    const at = messages.indexOf(note);
    return messages.slice(at + 1).some((m) => m.author.kind === 'agent' && m.author.session === by.session && (m.author.host ?? '') === (by.host ?? ''));
  };
  // Ids are built from the message that holds each question, never from the
  // question's own `message_id`, so a question record without one (or a stale
  // one) can never point a rule at a message that is not there.
  const openIds = new Set(
    messages.flatMap((m) => (m.author.kind === 'agent' && live(m) ? (m.questions ?? []).filter((q) => q.state === 'open').map((q) => `${m.id}/${q.key}`) : [])),
  );
  const targets: ReaskTarget[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map((m) => m.id));
    const first = group[0];
    if (!first) continue;
    const author = first.author.kind === 'agent' ? first.author : null;
    const own = { host: author?.host ?? null, session: author?.session ?? null };
    // A note to this session (an answer to one of its messages), or one sent to it from an ended session.
    const notes = messages.filter((m) => isReaskNote(m) && ((m.reply_to && ids.has(m.reply_to)) || (own.session && m.to?.session === own.session)));
    // A note waits until its session wrote again, and only while a question it lists is still open (rule 2a).
    const waits = (note: InboxMessageWire) =>
      !wroteAfter(note, note.to && note.to.session !== own.session ? { host: note.to.host, session: note.to.session } : own) &&
      (note.reask ?? []).some((id) => openIds.has(id));
    if (notes.some(waits)) continue;
    // The session's messages that still hold a question waiting on the person
    // (open, or picked and not sent), in thread order. Every rule below reads
    // these messages, not the questions' `message_id`, so the message a rule
    // names is always one of the session's own.
    const isWaiting = (q: InboxQuestion) => q.state === 'open' || q.state === 'picked';
    const holders = group.filter((m) => (m.questions ?? []).some(isWaiting));
    const target = holders.at(-1);
    if (!target) continue;
    const waiting = holders.flatMap((m) => (m.questions ?? []).filter(isWaiting));
    const open = waiting.filter((q) => q.state === 'open').length;
    const base = { message: target, session: own.session, host: own.host, name: agentName(first.author), open, picked: waiting.length - open };
    if (open === 0) {
      // Only picks: a plain reply per message carries them (owner's rule: picks go, never stranded).
      const replies = holders
        .map((m) => ({ message: m, questions: (m.questions ?? []).filter((q) => q.state === 'picked').map((q) => ({ key: q.key, revision: q.revision })) }))
        .filter((r) => r.questions.length > 0);
      targets.push({ ...base, kind: 'picks', replies });
      continue;
    }
    // Just answered a note: everything still waiting is in that one message,
    // and that message replies to the note.
    if (holders.length === 1) {
      const answers = target.reply_to ? messages.find((m) => m.id === target.reply_to) : undefined;
      if (answers && isReaskNote(answers)) continue;
    }
    targets.push({ ...base, kind: 'reask', replies: [] });
  }
  return targets;
}

/**
 * Re-ask is offered when two or more questions wait in the thread (open or
 * picked, not sent: approval "2+ questions are open") and some session has
 * an open one it can be asked for again. `messages`: the thread's live ones.
 */
export function reaskOffered(targets: readonly ReaskTarget[], messages?: readonly InboxMessageWire[]): boolean {
  const waiting = messages
    ? messages.reduce((n, m) => n + (m.author.kind === 'agent' ? (m.questions ?? []).filter((q) => q.state === 'open' || q.state === 'picked').length : 0), 0)
    : targets.reduce((n, t) => n + t.open + t.picked, 0);
  return waiting >= 2 && targets.some((t) => t.kind === 'reask' && t.open > 0);
}

/** "Claude Code", "Claude Code and Pi", or "2 sessions" when two share a name. */
export function reaskWho(targets: readonly ReaskTarget[]): string {
  const names = targets.filter((t) => t.kind === 'reask').map((t) => t.name);
  if (names.length === 1) return names[0]!;
  if (new Set(names).size < names.length) return `${names.length} sessions`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The button's tooltip: what pressing it does. */
export function reaskTooltip(targets: readonly ReaskTarget[]): string {
  const open = targets.reduce((n, t) => n + t.open, 0);
  const picks = targets.reduce((n, t) => n + t.picked, 0);
  const several = targets.filter((t) => t.kind === 'reask').length > 1;
  const what =
    open === 1
      ? `the open question again${several ? '' : ', with fresh context'}`
      : `${several ? 'their' : 'the'} ${open} open questions again, ${several ? 'each together in one message' : 'together in one message'} with fresh context`;
  const pickWords = picks > 0 ? ` Your ${plural(picks, 'pick')} ${picks === 1 ? 'is' : 'are'} sent too.` : '';
  return `Ask ${reaskWho(targets)} to ask ${what}. Questions that no longer apply are closed; until then they stay open here.${pickWords}`;
}

/** The note's line in the thread. `picks`: answers that went with it. */
export function reaskNoteSentence(agent: string, asked: number, picks: number): string {
  const head =
    asked === 1
      ? `You asked ${agent} to ask the open question again. It stays open here until it does.`
      : `You asked ${agent} to ask the ${asked} open questions again, together in one message. They stay open here until it does.`;
  return picks > 0 ? `${head} Your ${plural(picks, 'pick')} went with it.` : head;
}

/**
 * The note a question was last asked again in, while it is still open.
 * `messageId`: the message that holds the question (not the question's own
 * `message_id`, which a record may lack).
 */
export function reaskedIn(
  messages: readonly InboxMessageWire[],
  messageId: string,
  question: Pick<InboxQuestion, 'key' | 'state'>,
): InboxMessageWire | null {
  if (question.state !== 'open') return null;
  const id = `${messageId}/${question.key}`;
  return [...messages].reverse().find((m) => isReaskNote(m) && (m.reask ?? []).includes(id)) ?? null;
}

/** Who a Re-ask note went to: the agent of the message it answers, else `fallback` (the thread's asker). */
export function reaskNoteAgent(answered: InboxMessageWire['author'] | undefined, fallback: string): string {
  return answered?.kind === 'agent' ? agentName(answered) : fallback;
}
