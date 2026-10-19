/**
 * The replies one Send makes (pure, for the tests): the agent messages it
 * answers, and which reply each waiting annotation rides.
 */
import type { InboxAnnotationRecord, InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';

/** One reply of a Send: the message it answers, its picks, whether it skips, and the annotations it carries. */
export interface SendTarget {
  message: InboxMessageWire;
  questions: { key: string; revision: number }[];
  skips: boolean;
}

/**
 * Where each waiting annotation goes (review of #1997): a comment on an agent
 * message's text goes to the session that wrote that message. One whose
 * message the last reply already reaches (that message, or one its session
 * wrote) rides the last reply with the words, the file and the guide
 * comments; any other rides a reply to its own message, which joins the
 * targets in thread order when it is not one already (a comment never goes
 * to two replies). Returns the targets and the annotations each carries,
 * keyed by the message the reply answers.
 */
export function routeSendAnnotations(
  thread: InboxThread,
  targets: readonly SendTarget[],
  records: readonly InboxAnnotationRecord[],
): { targets: SendTarget[]; carried: Map<string, InboxAnnotationRecord[]> } {
  const carried = new Map<string, InboxAnnotationRecord[]>();
  const last = targets.at(-1);
  if (!last) return { targets: [...targets], carried };
  const put = (id: string, record: InboxAnnotationRecord) => carried.set(id, [...(carried.get(id) ?? []), record]);
  const extra: SendTarget[] = [];
  for (const record of records) {
    const message = record.message ? thread.messages.find((m) => m.id === record.message_id) : undefined;
    if (!message || message.id === last.message.id || sameSession(message, last.message)) {
      put(last.message.id, record);
      continue;
    }
    if (!targets.some((t) => t.message.id === message.id) && !extra.some((t) => t.message.id === message.id)) {
      extra.push({ message, questions: [], skips: false });
    }
    put(message.id, record);
  }
  if (extra.length === 0) return { targets: [...targets], carried };
  const order = new Map(thread.messages.map((m, index) => [m.id, index]));
  const before = [...targets.slice(0, -1), ...extra].sort((a, b) => (order.get(a.message.id) ?? 0) - (order.get(b.message.id) ?? 0));
  return { targets: [...before, last], carried };
}

/** Two agent messages one session wrote (a message with no session matches none). */
export function sameSession(a: InboxMessageWire, b: InboxMessageWire): boolean {
  if (a.author.kind !== 'agent' || b.author.kind !== 'agent') return false;
  return !!a.author.session && a.author.session === b.author.session && (a.author.host ?? '') === (b.author.host ?? '');
}

/**
 * The agent messages a Send answers, in thread order: each one with picks
 * waiting, and (`skip`, unless Keep open) each with questions left open,
 * which the Send skips on the reply to that message. The person's words
 * (which ride the last reply) go to the agent that wrote most recently,
 * never to an older asker: when the latest agent message comes from another
 * session than the last pick or skip answers, it comes last, with no picks
 * of its own; when the same session wrote both, the words ride the last
 * pick or skip, so one Send is one reply to that session.
 */
export function sendTargetsOf(thread: InboxThread, skip = true): SendTarget[] {
  const targets = thread.messages
    .filter((m) => m.author.kind === 'agent' && (m.questions ?? []).some((q) => q.state === 'picked' || (skip && q.state === 'open')))
    .map((m) => ({
      message: m,
      questions: (m.questions ?? []).filter((q) => q.state === 'picked').map((q) => ({ key: q.key, revision: q.revision })),
      skips: skip && (m.questions ?? []).some((q) => q.state === 'open'),
    }));
  const latest = thread.messages.filter((m) => m.author.kind === 'agent').at(-1) ?? thread.messages[0]!;
  const last = targets.at(-1)?.message;
  if (!last || (last.id !== latest.id && !sameSession(last, latest))) targets.push({ message: latest, questions: [], skips: false });
  return targets;
}

