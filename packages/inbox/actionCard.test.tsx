/**
 * The To do card (approval "inbox-next-actions", direction "In the thread")
 * and the row's count, as the window draws them. Failures to catch: the card
 * not replacing the `:::action` callout in its message (the Viewer seam); an
 * Open button for a link that is not http(s); Can't do it sent without its
 * reason; Done not offering Undo while its window runs; a closed card still
 * offering Done; the row not saying "1 to do"; a to-do reaching the picks or
 * the Send (the api split).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

const hasDom = typeof document !== 'undefined';
const { ActionCard } = (hasDom ? await import('./components/ActionCard') : {}) as typeof import('./components/ActionCard');
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { splitMessageActions } = await import('./actions');
const { waitCount } = await import('./format');

const BODY = [
  'Release 4.2 is built.',
  '',
  ':::action',
  'Approve the production deploy on Vercel',
  'The build waits under "Promote to Production".',
  'Where: https://vercel.com/acme/web/deployments',
  'Stopped: release 4.2 waits on it',
  'Watching: the deployment; I go on by myself once it is Ready',
  ':::',
].join('\n');

const parsed = parseInboxActionBlocks(BODY)[0]!;

function todo(over: Partial<InboxQuestion> = {}): InboxQuestion {
  return {
    key: parsed.key,
    position: 0,
    kind: 'action',
    prompt: parsed.prompt,
    context: parsed.why,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: parsed.stopped,
    holds_up: [],
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    superseded_by: null,
    set_aside_at: null,
    action: parsed.action,
    action_result: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());

test.skipIf(!hasDom)('an open to-do: what to do, why, Open for its link, what the agent watches, Done / Can\'t do it… / Add note', async () => {
  const marks: unknown[] = [];
  const el = mount(<ActionCard action={todo()} number={1} total={1} agent="Claude Code" onMark={async (mark) => (marks.push(mark), true)} />);
  const card = el.querySelector('[data-action-card]')!;
  expect(card.getAttribute('role')).toBe('group');
  expect(card.getAttribute('aria-label')).toBe('To do: Approve the production deploy on Vercel');
  expect(card.textContent).toContain('To do · something only you can do');
  expect(card.querySelector('.ib-badge')!.textContent).toBe('Stopped');
  expect(card.querySelector('h3')!.textContent).toBe('Approve the production deploy on Vercel');
  const open = card.querySelector<HTMLAnchorElement>('[data-action-open]')!;
  expect(open.href).toBe('https://vercel.com/acme/web/deployments');
  expect(open.rel).toBe('noopener noreferrer');
  expect(card.querySelector('[data-action-watching]')!.textContent).toBe('Claude Code is watching: the deployment; I go on by myself once it is Ready');
  click(card.querySelector('[data-action-done]')!);
  await settle();
  expect(marks).toEqual([{ outcome: 'done' }]);

  // Can't do it asks for the reason; nothing goes without one.
  click(card.querySelector('[data-action-cant]')!);
  const send = card.querySelector<HTMLButtonElement>('[data-action-cant-send]')!;
  expect(send.disabled).toBe(true);
  const area = card.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(card.querySelector('label')!.textContent).toBe("Why can't you? Claude Code gets this word for word.");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(area, "I'm not in the acme team; ask Dana.");
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  click(card.querySelector('[data-action-cant-send]')!);
  await settle();
  expect(marks.at(-1)).toEqual({ outcome: 'cant', note: "I'm not in the acme team; ask Dana." });
});

test.skipIf(!hasDom)('a run command is copied, not opened; a link that is not http(s) never becomes a button', () => {
  const run = mount(<ActionCard action={todo({ action: { where: null, where_url: null, run: 'npm login', watching: null } })} number={1} total={2} agent="Pi" onMark={async () => true} />);
  expect(run.querySelector('.ib-todo-cmd')!.textContent).toBe('npm login');
  expect(run.querySelector('[data-action-copy]')).not.toBeNull();
  expect(run.querySelector('[data-action-open]')).toBeNull();
  expect(run.textContent).toContain('To do 1 of 2');
});

test.skipIf(!hasDom)('after Done: Undo while the window runs; then the settled line, and no Done any more', async () => {
  const marks: unknown[] = [];
  const result = { outcome: 'done' as const, note: 'Approved.', at: '2026-10-21T15:12:00.000Z', by: 'person' as const };
  const pending = mount(<ActionCard action={todo({ state: 'picked', revision: 1, action_result: result })} number={1} total={1} agent="Claude Code" onMark={async (mark) => (marks.push(mark), true)} />);
  expect(pending.querySelector('[data-action-done]')).toBeNull();
  expect(pending.querySelector('[data-action-settled]')!.textContent).toContain('Goes to Claude Code in a few seconds.');
  click(pending.querySelector('[data-action-undo]')!);
  await settle();
  expect(marks).toEqual([null]);
  act(() => root?.unmount());
  host?.remove();

  const sent = mount(<ActionCard action={todo({ state: 'sent', revision: 1, sent_revision: 1, action_result: result })} number={1} total={1} agent="Claude Code" onMark={async () => true} />);
  expect(sent.querySelector('[data-action-card]')!.getAttribute('data-action-state')).toBe('done');
  expect(sent.querySelector('.ib-badge')!.textContent).toBe('Done');
  expect(sent.querySelector('[data-action-settled]')!.textContent).toContain('Sent to Claude Code.');
  expect(sent.querySelector('[data-action-undo]')).toBeNull();
  act(() => root?.unmount());
  host?.remove();

  const seen = mount(<ActionCard action={todo({ state: 'closed', revision: 1, action_result: { outcome: 'done', note: null, at: '2026-10-21T15:14:00.000Z', by: 'agent' } })} number={1} total={1} agent="Claude Code" onMark={async () => true} />);
  expect(seen.querySelector('[data-action-settled]')!.textContent).toMatch(/^Claude Code saw it done, /);
  expect(seen.querySelector('[data-action-done]')).toBeNull();
});

test.skipIf(!hasDom)("the card takes the `:::action` block's place in its message (the Viewer seam), and the window reads it out of `questions`", () => {
  const wire = {
    id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    project_id: 'prj_1',
    thread_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Approve the production deploy on Vercel',
    body: BODY,
    created_at: '2026-10-21T15:10:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    questions: [todo()],
  } as InboxMessageWire;
  const message = splitMessageActions(wire);
  // Out of `questions`: nothing that picks or sends answers meets it.
  expect(message.questions).toBeUndefined();
  expect(message.actions!.map((a) => a.key)).toEqual([parsed.key]);
  const el = mount(
    <MessageBody
      message={message}
      projectRoot="/work/web"
      onOpenAttachment={() => {}}
      readOnly
      answers={new Map()}
      onPick={() => {}}
      footerFor={() => null}
      renderAction={(block) => {
        const action = message.actions!.find((a) => a.key === parseInboxActionBlocks(BODY).find((p) => p.startLine === block.startLine)?.key);
        return action ? <ActionCard action={action} number={1} total={1} agent="Claude Code" onMark={async () => true} /> : undefined;
      }}
    />,
  );
  expect(el.textContent).toContain('Release 4.2 is built.');
  expect(el.querySelectorAll('[data-action-card]')).toHaveLength(1);
  // The block's own lines are never drawn as a callout beside the card.
  expect(el.textContent).not.toContain('Where: https://vercel.com');
});

test.skipIf(!hasDom)('the row says "1 to do", or "1 question, 1 to do", as plain text', () => {
  expect(waitCount(1, 1)).toBe('1 to do');
  expect(waitCount(2, 1)).toBe('1 question, 1 to do');
  expect(waitCount(3, 1)).toBe('2 questions, 1 to do');
  expect(waitCount(2, 0)).toBe('2 questions');
  expect(waitCount(1, 0)).toBe('');
  const row = (id: string, open: number, actions: number): InboxListRow => ({
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-21T15:10:00.000Z',
    last_at: '2026-10-21T15:10:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open, picked: 0, stopped: true, holds_up: [], prompt: null, actions },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'web' },
    thread_name: null,
    section: 'stopped',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  });
  const sections: InboxListSection[] = [{ id: 'stopped', label: 'Stopped on you', threads: [row('msg_a', 1, 1), row('msg_b', 2, 1)] }];
  const el = mount(
    <SidebarProvider>
      <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} />
    </SidebarProvider>,
  );
  const count = (id: string) => el.querySelector(`[data-thread-id="${id}"] .ib-c`)?.textContent;
  expect(count('msg_a')).toBe('1 to do');
  expect(count('msg_b')).toBe('1 question, 1 to do');
});
