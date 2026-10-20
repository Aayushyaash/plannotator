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

/** One session's Re-ask: the message it goes to, and what it carries. */
export interface ReaskTarget {
  /** The session's latest message with a question still open or picked: the note answers it. */
  message: InboxMessageWire;
  session: string | null;
  host: string | null;
  /** "Claude Code": the agent as the thread names it. */
  name: string;
  /** Open questions with no pick: asked again. */
  open: number;
  /** Picked and not sent: they go with the note as answers. */
  picked: number;
}

const isReaskNote = (m: InboxMessageWire): boolean => m.author.kind === 'person' && (m.reask?.length ?? 0) > 0;

/**
 * The sessions a Re-ask would go to now. A session is left out while its
 * note waits (no message of that session after its latest note), right after
 * it answered a note (every question it still has open sits in its one
 * message that answered the note), and when nothing of its is open.
 * `live` says which messages still take answers (not closed by an archive).
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
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const targets: ReaskTarget[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map((m) => m.id));
    const first = group[0]!;
    const author = first.author.kind === 'agent' ? first.author : null;
    // The latest note this session was sent (a reply to one of its messages, or addressed to it).
    const notes = messages.filter((m) => isReaskNote(m) && ((m.reply_to && ids.has(m.reply_to)) || (author?.session && m.to?.session === author.session)));
    const lastNote = notes.at(-1);
    const lastOwn = group.at(-1)!;
    if (lastNote && (index.get(lastNote.id) ?? 0) > (index.get(lastOwn.id) ?? 0)) continue;
    const waiting = group.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'open' || q.state === 'picked'));
    const open = waiting.filter((q) => q.state === 'open').length;
    if (open === 0) continue;
    // Just answered a note: everything still waiting is in that one message.
    const holders = new Set(waiting.map((q) => q.message_id));
    if (holders.size === 1) {
      const holder = group.find((m) => holders.has(m.id))!;
      const answers = holder.reply_to ? messages.find((m) => m.id === holder.reply_to) : undefined;
      if (answers && isReaskNote(answers)) continue;
    }
    const target = [...group].reverse().find((m) => (m.questions ?? []).some((q) => q.state === 'open' || q.state === 'picked'))!;
    targets.push({
      message: target,
      session: author?.session ?? null,
      host: author?.host ?? null,
      name: agentName(first.author),
      open,
      picked: waiting.length - open,
    });
  }
  return targets;
}

/** Re-ask is offered when two or more questions wait, at least one of them with no pick (approval: "2+ questions are open"). */
export function reaskOffered(targets: readonly ReaskTarget[]): boolean {
  const waiting = targets.reduce((n, t) => n + t.open + t.picked, 0);
  return waiting >= 2 && targets.some((t) => t.open > 0);
}

/** "Claude Code", "Claude Code and Pi", or "2 sessions" when two share a name. */
export function reaskWho(targets: readonly ReaskTarget[]): string {
  const names = targets.map((t) => t.name);
  if (names.length === 1) return names[0]!;
  if (new Set(names).size < names.length) return `${names.length} sessions`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The button's tooltip: what pressing it does. */
export function reaskTooltip(targets: readonly ReaskTarget[]): string {
  const open = targets.reduce((n, t) => n + t.open, 0);
  const picks = targets.reduce((n, t) => n + t.picked, 0);
  const several = targets.length > 1;
  const what =
    open === 1
      ? `the open question again${several ? '' : ', with fresh context'}`
      : `${several ? 'their' : 'the'} ${open} open questions again, ${several ? 'each together in one message' : 'together in one message'} with fresh context`;
  const pickWords = picks > 0 ? ` Your ${plural(picks, 'pick')} ${picks === 1 ? 'goes' : 'go'} with it.` : '';
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

/** The note a question was last asked again in, while it is still open. */
export function reaskedIn(messages: readonly InboxMessageWire[], question: Pick<InboxQuestion, 'message_id' | 'key' | 'state'>): InboxMessageWire | null {
  if (question.state !== 'open') return null;
  const id = `${question.message_id}/${question.key}`;
  return [...messages].reverse().find((m) => isReaskNote(m) && m.reask!.includes(id)) ?? null;
}
