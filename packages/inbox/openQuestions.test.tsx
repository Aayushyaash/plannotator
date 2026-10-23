/**
 * Open questions in one thread (approval "inbox-thread-open-questions",
 * option A): the "N open questions" button in the foot's button row and the
 * short list it opens. What is proved: the count (open and picked-not-sent;
 * replaced questions and action items left out), when the button shows, the
 * list's name (no drawn heading or foot line), rows, states and places, the
 * Re-ask item at its foot (owner, 2026-10-23), choosing a row unfolding its
 * message and ringing the card, Escape putting focus back on the button, the
 * phone's bottom sheet, no button when nothing is open, the label forms and
 * the pill's place that keep the foot on one line (footFit.ts), and focus
 * landing on Reply when the button goes while its list is open.
 *
 * The pure rules (openQuestions.ts) run everywhere; the window's parts are
 * DOM-gated: they run under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { openQuestionsShown, openQuestionState, placeOf, reaskItemLabel, threadOpenQuestions } from './openQuestions';
import { footFitCandidates, onOneLine, openQuestionsFormText, pillHitsButtons } from './footFit';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-10-22T09:00:00.000Z' };
const A: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const id = (n: number) => `msg_01M5OQ0000000000000000000${n}`;
const [M1, M2, M3, , M5, M6] = [1, 2, 3, 4, 5, 6].map(id) as [string, string, string, string, string, string];

const block = (prompt: string, extra: string[] = []) => [':::question', prompt, ...extra, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

function questionsOf(messageId: string, body: string, patch: Partial<InboxQuestion> = {}): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: null,
    suggested_text: null,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: A.session,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
    ...patch,
  }));
}

const answerFor = (q: InboxQuestion, selected: string[]): QuestionAnswer => ({ v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected });

function agent(n: number, body: string, seq: number, patch: (q: InboxQuestion) => Partial<InboxQuestion> = () => ({}), extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  const messageId = id(n);
  const questions = questionsOf(messageId, body).map((q) => ({ ...q, ...patch(q) }));
  return {
    id: messageId,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: n === 1 ? null : M1,
    author: A,
    subject: n === 1 ? 'Retry worker for failed Stripe charges' : null,
    body,
    created_at: `2026-10-22T${String(9 + n).padStart(2, '0')}:15:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq,
    ...(n === 1 ? { person_seen_seq: 6 } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...extra,
  };
}

const ACTION: InboxQuestion = {
  ...questionsOf(M6, block('x'))[0]!,
  key: 'a-00000001',
  kind: 'action',
  prompt: 'Approve the 2FA prompt',
  choices: [],
  action: { where: null, where_url: null, run: null, watching: null },
  action_result: null,
};

/**
 * Six messages, all read (the look is at 6), so the fold folds the first four:
 * M2 hides in the middle fold ("1 earlier message"), M3 and M4 fold to a line.
 * M5 holds a pick not sent (it stays open), M6 is the last.
 */
function sample(): InboxMessageWire[] {
  return [
    agent(1, `Which queue?\n\n${block('Which queue backs the retry worker?')}`, 1, () => ({ state: 'sent' })),
    agent(2, `Rates.\n\n${block('How many times should a rate-limited charge be retried?')}`, 2),
    agent(3, `The 409 row.\n\n${block('Which way should the worker go on a Stripe 409?', ['Stopped: the deploy'])}`, 3),
    agent(4, `Old.\n\n${block('Log every attempt?')}`, 4, () => ({ state: 'superseded', superseded_by: { message_id: M6, key: null } })),
    agent(5, `Staging is green.\n\n${block('Ship the retry worker behind a flag?', ['Holds up: the retry worker; the admin page'])}`, 5, (q) => ({ state: 'picked', answer: answerFor(q, ['Yes']), revision: 1 })),
    agent(6, `Last one.\n\n${block('Anything the on-call runbook should say?')}`, 6, () => ({}), { actions: [ACTION] }),
  ];
}

const thread = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Retry worker for failed Stripe charges', thread_name: null, resolved_at: null, messages });

describe('the rules (openQuestions.ts)', () => {
  test('counts open and picked-not-sent questions; replaced ones and action items are left out', () => {
    const { questions, replaced } = threadOpenQuestions(sample());
    expect(questions.map((q) => q.messageId)).toEqual([M2, M3, M5, M6]);
    expect(questions.map((q) => q.prompt)).not.toContain('Approve the 2FA prompt');
    expect(replaced).toBe(1);
  });

  test('a row shows the draft pick first, else Stopped, else Holds up', () => {
    const { questions } = threadOpenQuestions(sample());
    expect(questions.map(openQuestionState)).toEqual([null, { kind: 'stopped' }, { kind: 'draft' }, null]);
    const holds = { ...questions[2]!, picked: false };
    expect(openQuestionState(holds)).toEqual({ kind: 'holds', count: 2 });
  });

  test('messages the archive closed are not listed', () => {
    const { questions } = threadOpenQuestions(sample(), (m) => m.id !== M2);
    expect(questions.map((q) => q.messageId)).toEqual([M3, M5, M6]);
  });

  test('shown whenever a question waits, or Re-ask is offered with only action items (owner, 2026-10-23)', () => {
    const { questions } = threadOpenQuestions(sample());
    expect(openQuestionsShown([])).toBe(false);
    expect(openQuestionsShown([], true)).toBe(true);
    expect(openQuestionsShown(questions.slice(0, 1))).toBe(true);
    expect(openQuestionsShown(questions.slice(0, 2))).toBe(true);
  });

  test("the Re-ask item's words: singular for one thing asked again", () => {
    expect(reaskItemLabel(1)).toBe('Re-ask in a new message');
    expect(reaskItemLabel(3)).toBe('Re-ask in one new message');
  });

  test('above or below by the middle of the card against the middle of the view', () => {
    const view = { top: 0, bottom: 600 };
    expect(placeOf({ top: 100, bottom: 200 }, view)).toBe('above');
    expect(placeOf({ top: 250, bottom: 590 }, view)).toBe('below');
    expect(placeOf({ top: 900, bottom: 1000 }, view)).toBe('below');
  });
});

describe('fitting the foot on one line (footFit.ts)', () => {
  test('the forms read "6 open questions", "6 open", "6"', () => {
    expect(openQuestionsFormText(6, 'full')).toBe('6 open questions');
    expect(openQuestionsFormText(1, 'full')).toBe('1 open question');
    expect(openQuestionsFormText(6, 'short')).toBe('6 open');
    expect(openQuestionsFormText(12, 'count')).toBe('12');
  });

  test('each form is tried on the usual spacing, then tightened, longest first; a phone starts at "6 open"', () => {
    const order = (max: Parameters<typeof footFitCandidates>[0]) => footFitCandidates(max).map((f) => `${f.form}${f.tight ? '+tight' : ''}`);
    expect(order('full')).toEqual(['full', 'full+tight', 'short', 'short+tight', 'count', 'count+tight']);
    expect(order('short')).toEqual(['short', 'short+tight', 'count', 'count+tight']);
  });

  test('one line: every top within a pixel of the first', () => {
    expect(onOneLine([846, 846.4, 845.6])).toBe(true);
    expect(onOneLine([553, 553, 605])).toBe(false);
  });

  test('the pill lies over a button only when one sits under the middle of the row', () => {
    const row = { left: 0, right: 388, top: 0, bottom: 44 };
    const pill = { width: 90, height: 36 };
    const at = (left: number, right: number) => ({ left, right, top: 0, bottom: 44 });
    // Reply alone: the middle is free.
    expect(pillHitsButtons(row, pill, [at(0, 110)])).toBe(false);
    // Reply, Re-ask and "2 open": Re-ask sits under the middle.
    expect(pillHitsButtons(row, pill, [at(0, 110), at(118, 230), at(238, 360)])).toBe(true);
    // Right to left, mirrored: the same.
    expect(pillHitsButtons(row, pill, [at(278, 388)])).toBe(false);
    expect(pillHitsButtons(row, pill, [at(160, 270)])).toBe(true);
  });
});

// ── The window ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('[data-open-questions-list]').forEach((n) => n.closest('.ib-oq-pos')?.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render(t: InboxThread, options: { phone?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(t, options));
  });
  await settle();
  return host;
}

function pane(t: InboxThread, options: { phone?: boolean } = {}) {
  return (
    <ThreadPane
      thread={t}
      sent={null}
      lookSeq={6}
      phone={options.phone === true}
      onQuestions={() => {}}
      onChanged={async () => {}}
      onClose={() => {}}
      file={null}
      onOpenFile={() => {}}
      onOpenGuide={() => {}}
    />
  );
}

const button = () => document.querySelector<HTMLButtonElement>('[data-open-questions]');
const list = () => document.querySelector<HTMLElement>('[data-open-questions-list]');
const rows = () => [...(list()?.querySelectorAll<HTMLElement>('.ib-oq-row') ?? [])];
const reaskItem = () => list()?.querySelector<HTMLElement>('[data-reask]') ?? null;

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

async function openList() {
  await press(button()!);
  await until(() => !!list(), 'the list');
}

test.skipIf(!hasDom)('the button sits after Reply (no Re-ask in the foot), counts 4 (no replaced question, no action item), and opens a menu', async () => {
  const el = await render(thread(sample()));
  const b = button()!;
  expect(b.textContent?.trim()).toBe('4 open questions');
  const foot = [...el.querySelectorAll('[data-foot-buttons] button')].map((n) => n.textContent?.trim());
  expect(foot).not.toContain('Re-ask');
  expect(el.querySelector('[data-foot-buttons] [data-reask]')).toBeNull();
  expect(foot.indexOf('4 open questions')).toBe(foot.indexOf('Edit draft') + 1);
  expect(b.getAttribute('aria-haspopup')).toBe('menu');
  expect(b.getAttribute('aria-expanded')).toBe('false');
  expect(b.hasAttribute('title')).toBe(false);
  await openList();
  expect(b.getAttribute('aria-expanded')).toBe('true');
  expect(list()!.getAttribute('role')).toBe('menu');
  expect(list()!.getAttribute('aria-label')).toBe('4 open questions in this thread');
  // No drawn heading, count line or foot line: the name carries the count.
  expect(list()!.textContent).not.toContain('in this thread');
  expect(list()!.querySelector('.ib-oq-head, .ib-oq-sub, .ib-oq-foot')).toBeNull();
  expect(rows().map((r) => r.querySelector('.ib-oq-p')!.textContent)).toEqual([
    'How many times should a rate-limited charge be retried?',
    'Which way should the worker go on a Stripe 409?',
    'Ship the retry worker behind a flag?',
    'Anything the on-call runbook should say?',
  ]);
  // States: Stopped, the draft pick (it wins over Holds up), and where each card sits.
  expect(rows()[1]!.querySelector('.ib-b-stop')!.textContent).toBe('Stopped');
  expect(rows()[2]!.querySelector('.ib-oq-draft')!.textContent).toBe('Draft · Yes');
  expect(rows()[0]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· in a folded message$/);
  expect(rows()[1]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· in a folded message$/);
  expect(rows()[3]!.querySelector('.ib-oq-when')!.textContent).toMatch(/· (below|above)$/);
  expect(list()!.textContent).not.toContain('Choose one');
  // Re-ask at the foot, a menu item after the rows.
  const item = reaskItem()!;
  expect(item.getAttribute('role')).toBe('menuitem');
  expect(item.textContent?.trim()).toBe('Re-ask in one new message');
  expect([...list()!.querySelectorAll('[role="menuitem"]')].at(-1)).toBe(item);
  expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toMatch(/^Ask Claude Code to ask the 3 open questions and 1 action item again, together in one message.* Your 1 pick is sent too\.$/);
  // No native tooltips anywhere in the list.
  expect(list()!.querySelector('[title]')).toBeNull();
});

test.skipIf(!hasDom)('choosing a row in the middle fold opens that message, scrolls to its card and rings it', async () => {
  const el = await render(thread(sample()));
  // M2 is hidden behind "1 earlier message": its card is not drawn.
  expect(el.querySelector(`[data-message-id="${M2}"] [data-question-key]`)).toBeNull();
  await openList();
  await act(async () => rows()[0]!.click());
  await until(() => !list(), 'the list to close');
  await until(() => !!el.querySelector(`[data-message-id="${M2}"] [data-question-key]`), 'the folded message to open');
  const card = el.querySelector<HTMLElement>(`[data-message-id="${M2}"] [data-question-key]`)!;
  await until(() => card.classList.contains('ib-q-target'), 'the ring on the card');
  // Focus went to the card, not back to the button.
  expect(document.activeElement).toBe(card);
});

test.skipIf(!hasDom)('a folded message (one line) opens too', async () => {
  const el = await render(thread(sample()));
  expect(el.querySelector(`[data-message-id="${M3}"] [data-question-key]`)).toBeNull();
  await openList();
  await act(async () => rows()[1]!.click());
  await until(() => !!el.querySelector(`[data-message-id="${M3}"] [data-question-key].ib-q-target`), 'the ringed card in M3');
});

test.skipIf(!hasDom)('arrow keys move through the rows; Escape closes the list and puts focus back on the button', async () => {
  await render(thread(sample()));
  const b = button()!;
  await act(async () => b.focus());
  await act(async () => {
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => !!list(), 'the list from the keyboard');
  await until(() => rows().some((r) => r.hasAttribute('data-highlighted')), 'a highlighted row');
  const highlighted = () => rows().findIndex((r) => r.hasAttribute('data-highlighted'));
  const start = highlighted();
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await until(() => highlighted() === start + 1, 'the next row');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !list(), 'the list to close on Escape');
  await until(() => document.activeElement === b, 'focus back on the button');
  expect(b.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('on a phone: "4 open" named in full, and the list is a bottom sheet with a scrim and a close', async () => {
  await render(thread(sample()), { phone: true });
  const b = button()!;
  expect(b.textContent?.trim()).toBe('4 open');
  expect(b.getAttribute('aria-label')).toBe('4 open questions');
  await openList();
  const positioner = list()!.closest('.ib-oq-pos')!;
  expect(positioner.hasAttribute('data-phone')).toBe(true);
  expect(document.querySelector('[data-open-questions-scrim]')).not.toBeNull();
  expect(reaskItem()?.textContent?.trim()).toBe('Re-ask in one new message');
  const close = list()!.querySelector<HTMLButtonElement>('[data-open-questions-close]')!;
  expect(close.getAttribute('aria-label')).toBe('Close');
  await act(async () => close.click());
  await until(() => !list(), 'the sheet to close');
});

const allSent = (keepAction: boolean) =>
  sample().map((m) => ({
    ...m,
    ...(m.questions ? { questions: m.questions.map((q) => (q.state === 'superseded' ? q : { ...q, state: 'sent' as const, answer: q.answer })) } : {}),
    ...(m.actions && !keepAction ? { actions: m.actions.map((a) => ({ ...a, state: 'sent' as const })) } : {}),
  }));

test.skipIf(!hasDom)('no button when nothing is open', async () => {
  await render(thread(allSent(false)));
  expect(button()).toBeNull();
});

test.skipIf(!hasDom)('only an action item open: the button counts it, and its list is Re-ask alone', async () => {
  await render(thread(allSent(true)));
  expect(button()!.textContent?.trim()).toBe('1 open action item');
  await openList();
  expect(list()!.getAttribute('aria-label')).toBe('1 open action item in this thread');
  expect(rows()).toHaveLength(0);
  expect(reaskItem()!.textContent?.trim()).toBe('Re-ask in a new message');
});

test.skipIf(!hasDom)('one open question in a short, unfolded thread: the button shows, with Re-ask in the singular', async () => {
  await render(thread([agent(1, `One call.\n\n${block('Ship it?')}`, 1, () => ({}), { person_seen_seq: 0 })]));
  expect(button()!.textContent?.trim()).toBe('1 open question');
  await openList();
  expect(rows()).toHaveLength(1);
  expect(reaskItem()!.textContent?.trim()).toBe('Re-ask in a new message');
});

test.skipIf(!hasDom)("the button going while its list is open puts focus on the foot's Reply, never the page", async () => {
  const el = await render(thread(sample()));
  await openList();
  await act(async () => rows()[0]!.focus());
  // Every open question and action item answered elsewhere: the button (and its list) goes.
  await act(async () => root!.render(pane(thread(allSent(false)))));
  await settle();
  expect(button()).toBeNull();
  expect(list()).toBeNull();
  await until(() => document.activeElement === el.querySelector('[data-reply-button]'), 'focus on Reply');
});
