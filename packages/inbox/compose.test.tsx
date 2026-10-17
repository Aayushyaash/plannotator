/**
 * Compose, as the window draws it (approval record "inbox-compose-to-agent"):
 * the whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (its own process, tests/helpers/inbox-dom-server.ts), the window's fetches
 * carried to it over loopback, and agent sessions made live by real bridge
 * polls with the registry's token. What is proved: with no live agent, Send
 * sends nothing and says so; closing with words asks Keep draft / Discard
 * (Escape asks too, and a second Escape goes back); Discard keeps nothing;
 * Keep draft makes the sidebar's Drafts row and the Drafts page row; delete
 * has Undo; with a live session To is prefilled and Send starts the thread
 * addressed to it (the list row draws that agent, "To <agent>").
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';

import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let dir: string | null = null;
let projects: string[] = [];
/** The seeded world's thread ids (tests/helpers/inbox-dom-server.ts). */
let seeded: { waiting: string } | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** When set, the server's answer to a compose Send (POST /api/inbox/messages) is this instead. */
let sendAnswer: { status: number; body: Record<string, unknown> } | null = null;

function loopback(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

/** One poll from an agent connection working in `project`: the session is live for 30 s after it. */
async function poll(session: string, hostName: string, project: string) {
  const { token } = JSON.parse(readFileSync(join(dir!, 'data', 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  const answer = await loopback(
    '/api/inbox/bridge/poll',
    'POST',
    JSON.stringify({ session, host: hostName, waitMs: 0, project_path: project, started_at: Date.now() - 60_000, busy: false }),
    { Authorization: `Bearer ${token}` },
  );
  expect(answer.status).toBe(200);
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-compose-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_BROWSER: NO_BROWSER },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as { port: number; worlds: { waiting: string }[] };
  port = started.port;
  seeded = started.worlds[0]!;
  const model = JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { root: string }[] };
  projects = model.projects.map((p) => p.root);
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    if (sendAnswer && method === 'POST' && path === '/api/inbox/messages') {
      return new Response(JSON.stringify(sendAnswer.body), { status: sendAnswer.status, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!host!.querySelector('.ib-side [data-open-compose]'), 'the window');
  return host;
}

const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement | null;

function type(words: string) {
  const text = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const key = (k: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    (dialog()!.querySelector('textarea') ?? dialog()!).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  });

async function openCompose(el: HTMLElement) {
  act(() => (el.querySelector('.ib-side [data-open-compose]') as HTMLButtonElement).click());
  await until(() => !!dialog()?.querySelector('[data-compose-to]'), 'compose');
}

async function drafts(): Promise<{ id: string; body: string; status: string }[]> {
  return (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; body: string; status: string }[] }).drafts;
}

test.skipIf(!hasDom)('no live agent: Send sends nothing and says so; Escape asks Keep draft / Discard, a second Escape goes back; Discard keeps nothing', async () => {
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  expect(dialog()!.querySelector('[data-compose-note="none"]')?.textContent).toContain('Nothing can be sent until one is.');
  // An empty compose closes at once, asking nothing.
  key('Escape');
  await until(() => dialog() === null, 'compose closed');

  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="none"]') !== null, 'the no-agent state');
  type('Rename the Quiet section to Done?');
  await until(() => chipInput().value === 'Quiet section', 'the chip named from the message');
  expect(dialog()!.querySelector('[data-compose-send]')?.getAttribute('aria-disabled')).toBe('true');
  key('Enter', { metaKey: true });
  await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  expect(dialog()!.querySelector('[data-compose-error]')?.textContent).toBe('Nothing sent: no live agent is chosen. Save it as a draft.');
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);

  key('Escape');
  expect(dialog()!.querySelector('[data-compose-question]')?.textContent).toContain('Keep this message as a draft?');
  key('Escape');
  expect(dialog()!.querySelector('[data-compose-question]')).toBeNull();
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-discard]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  expect(await drafts()).toEqual([]);
  expect(el.querySelector('[data-drafts-nav]')).toBeNull();
});

test.skipIf(!hasDom)('Keep draft: the sidebar\'s Drafts row and the Drafts page list it with its chip; delete has Undo', async () => {
  const el = await renderApp();
  await openCompose(el);
  type('Idea: group the list by session.');
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-keep]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  await until(() => el.querySelector('[data-drafts-nav]')?.textContent === 'Drafts1', 'the Drafts row');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('It waits under Drafts and never sends itself.');

  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  const row = el.querySelector('[data-draft-id]')!;
  expect(row.querySelector('[data-draft-chip]')?.textContent).toBe('No agent chosen');
  expect(row.textContent).toContain('Idea: group the list by session');

  // From the keyboard: the delete button has focus; with no other draft it goes to the Drafts heading, never the page.
  const del = row.querySelector('[data-draft-delete]') as HTMLButtonElement;
  act(() => del.focus());
  act(() => del.click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 0, 'the row gone');
  await until(() => document.activeElement === el.querySelector('[data-drafts-page] h1'), 'focus on the Drafts heading');
  expect(await drafts()).toEqual([]);
  act(() => (document.querySelector('[data-toast-undo]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft back');
  expect((await drafts()).map((d) => d.body)).toEqual(['Idea: group the list by session.']);
});

test.skipIf(!hasDom)('a live session: To is prefilled, Send starts the thread addressed to it, and the draft it came from goes', async () => {
  await poll('ses_live_dom', 'claude-code', projects[0]!);
  const el = await renderApp('#drafts');
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  await until(() => el.querySelector('[data-draft-chip]')?.textContent === 'No agent chosen', 'the chip');
  act(() => (el.querySelector('.ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_live_dom"]') !== null && dialog() !== null, 'To prefilled');
  expect(dialog()!.querySelector('[data-compose-status]')?.textContent).toBe('Claude Code takes it as its next turn.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  const send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body).toMatchObject({ to: { host: 'claude-code', session: 'ses_live_dom' }, body: 'Idea: group the list by session.' });
  expect(typeof send.body.draft_id).toBe('string');
  expect(document.querySelector('[data-inbox-toast]')?.textContent).toContain('Sent to Claude Code');
  // The row that opened it is gone: focus goes to the Drafts heading (no other draft), never the page.
  await until(() => document.activeElement === el.querySelector('[data-drafts-page] h1'), 'focus on the Drafts heading');
  expect(await drafts()).toEqual([]);
  await until(() => el.querySelector('[data-drafts-nav]') === null, 'no Drafts row');
  const sections = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections;
  const row = sections.flatMap((s) => s.threads).find((t) => t.subject === 'Idea: group the list by session')!;
  expect(row).toMatchObject({ section: 'sent', addressee: { host: 'claude-code', session: 'ses_live_dom' } });
});

/** The ids of the list's rows on screen, by section. */
function rowsOnScreen(el: HTMLElement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of el.querySelectorAll<HTMLElement>('.ib-listcol .ib-lbody [data-thread-id]')) {
    const section = r.closest('[data-section-id]')?.getAttribute('data-section-id') ?? '?';
    (out[section] ??= []).push(r.getAttribute('data-thread-id')!);
  }
  return out;
}

async function threadIdOf(subject: string): Promise<string> {
  const sections = (JSON.parse((await loopback('/api/inbox/threads?archived=exclude')).text) as { sections: InboxListSection[] }).sections;
  const row = sections.flatMap((s) => s.threads).find((t) => t.subject === subject);
  expect(row?.section).toBe('sent');
  return row!.thread_id;
}

// The failure this guards (the owner, 2026-10-16: "When I create a new thread
// and hit send, why doesn't it show up in the Sent list? I don't see it in the
// inbox list at all."): with a thread open the held list took no new row, so
// the thread the person had just started was nowhere in the list until they
// closed the thread they were reading.
test.skipIf(!hasDom)('Send with a thread open: the new thread is in Sent at once, "To Claude Code", and the rows on screen keep their places', async () => {
  await poll('ses_sent_open', 'claude-code', projects[0]!);
  const el = await renderApp(`#thread=${seeded!.waiting}`);
  await until(() => el.querySelector('section.ib-pane') !== null && el.querySelector('.ib-listcol .ib-lbody [data-thread-id]') !== null, 'the thread and the list');
  const before = rowsOnScreen(el);
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="ses_sent_open"]') !== null, 'To prefilled');
  type('Look at the flaky upload test while I read this.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const id = await threadIdOf('Look at the flaky upload test while I read this');
  await until(() => (rowsOnScreen(el).sent ?? []).includes(id), 'the new row in Sent');
  const row = el.querySelector<HTMLElement>(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`)!;
  expect(row.textContent).toContain('To Claude Code');
  // The thread being read stays open, and every other row is where it was.
  expect(el.querySelector('section.ib-pane')).not.toBeNull();
  const after = rowsOnScreen(el);
  for (const [section, ids] of Object.entries(before)) expect((after[section] ?? []).filter((t) => t !== id)).toEqual(ids);
});

test.skipIf(!hasDom)('Send with no thread open: the new thread is in Sent at once', async () => {
  await poll('ses_sent_list', 'claude-code', projects[0]!);
  const el = await renderApp();
  await until(() => el.querySelector('.ib-listcol .ib-lbody [data-thread-id]') !== null, 'the list');
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to="ses_sent_list"]') !== null, 'To prefilled');
  type('Draft the release notes for the paste fix.');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  const id = await threadIdOf('Draft the release notes for the paste fix');
  await until(() => (rowsOnScreen(el).sent ?? []).includes(id), 'the new row in Sent');
});

test.skipIf(!hasDom)('git too slow to tell the project (project_unresolved): the dialog stays with the words and says to press Send again', async () => {
  await poll('ses_live_dom', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  type('Plan the retry budget.');
  sendAnswer = { status: 503, body: { code: 'project_unresolved', error: 'Could not tell which project /x belongs to: git did not answer in time. Nothing was sent or saved; try the same call again.' } };
  try {
    act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
    await until(() => dialog()!.querySelector('[data-compose-error]') !== null, 'the error');
  } finally {
    sendAnswer = null;
  }
  expect(dialog()!.querySelector('[data-compose-error]')!.textContent).toBe('Could not tell which project that session works in: git did not answer in time. Nothing was sent; press Send again.');
  expect((dialog()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Plan the retry budget.');
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-discard]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
});

test.skipIf(!hasDom)('the To picker: one line per session, a start time only where one project has two live sessions, and To names the agent and project', async () => {
  const other = join(dir!, 'other-project');
  mkdirSync(other, { recursive: true });
  await poll('ses_pair_a', 'claude-code', projects[0]!);
  await poll('ses_pair_b', 'pi', projects[0]!);
  await poll('ses_solo', 'claude-code', other);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  act(() => (dialog()!.querySelector('[data-compose-to]') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-compose-session="ses_solo"]') !== null, 'the picker');
  const option = (session: string) => dialog()!.querySelector(`[role="option"][data-compose-session="${session}"]`)!;
  // No project groups: the options sit straight in the listbox.
  expect(dialog()!.querySelector('[role="listbox"] [role="group"]')).toBeNull();
  expect(option('ses_solo').parentElement!.getAttribute('role')).toBe('listbox');
  // Two live sessions in one project: each names its start; the project with one does not.
  expect(option('ses_pair_a').querySelector('[data-compose-started]')).not.toBeNull();
  expect(option('ses_pair_b').querySelector('[data-compose-started]')).not.toBeNull();
  expect(option('ses_solo').querySelector('[data-compose-started]')).toBeNull();
  expect(option('ses_pair_a').getAttribute('aria-label')).toContain(', started ');
  expect(option('ses_solo').getAttribute('aria-label')).not.toContain('started');
  expect(option('ses_solo').getAttribute('aria-label')).toContain('Claude Code in other-project');
  // Pick the solo session: To names the agent and the project (the approved "Claude Code · plannotator").
  act(() => (option('ses_solo') as HTMLElement).click());
  await until(() => dialog()!.querySelector('[data-compose-to="ses_solo"]') !== null, 'To changed');
  const to = dialog()!.querySelector('[data-compose-to]')!;
  expect(to.querySelector('b')!.textContent).toBe('Claude Code');
  expect(to.querySelector('.ib-cp-tod')!.textContent).toBe('· other-project');
  key('Escape');
  await until(() => dialog() === null, 'compose closed');
});

const chip = () => dialog()!.querySelector('[data-compose-thread-name]') as HTMLElement;
const chipInput = () => dialog()!.querySelector('[data-compose-thread-name] input') as HTMLInputElement;
const chipError = () => dialog()!.querySelector('[data-compose-thread-name-error]');
/** Type into the chip as a person does: focus, the value, the input event. */
function fillChip(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    chipInput().focus();
    setter.call(chipInput(), value);
    chipInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const blurChip = () => act(() => chipInput().blur());

test.skipIf(!hasDom)('the thread chip follows the message until typed in; typed, it stays; emptied, it follows again once focus leaves; a draft keeps only a typed name', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  // Nothing written yet: an empty chip with its placeholder, right under To, before the message.
  expect(chip().getAttribute('data-compose-thread-name')).toBe('auto');
  expect(chip().hasAttribute('data-empty')).toBe(true);
  expect(chipInput().value).toBe('');
  expect(chipInput().placeholder).toBe('Name this thread');
  expect(dialog()!.querySelector('[data-compose-thread-row] .ib-cp-tol')!.textContent).toBe('Thread');
  expect(dialog()!.querySelector('[data-compose-subject]')).toBeNull();

  // It follows the message, a short name, live, marked "auto" (seen, and heard through aria-describedby).
  type('can you fix the paste bug in the reply box');
  await until(() => chipInput().value === 'Paste bug', 'the chip named from the message');
  expect(chip().hasAttribute('data-auto')).toBe(true);
  expect(chip().querySelector('.ib-cp-tname-auto')?.textContent).toBe('auto');
  const described = () => chipInput().getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
  expect(described()).toContain('Named from your message until you type here.');
  expect(chipInput().hasAttribute('title')).toBe(false);
  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'the chip follows the message');
  // A bare question has nothing to name: the placeholder again, nothing invented.
  type('What do you think?');
  await until(() => chipInput().value === '', 'nothing to name');

  // Typed in, it is the person's: the message no longer moves it.
  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'named again');
  fillChip('Board ideas');
  expect(chip().getAttribute('data-compose-thread-name')).toBe('edited');
  expect(chip().hasAttribute('data-auto')).toBe(false);
  expect(described()).toContain('Your name for the thread.');
  type('can you fix the paste bug in the reply box');
  await new Promise((r) => setTimeout(r, 400));
  expect(chipInput().value).toBe('Board ideas');

  // Emptied: empty while the caret is in it, then it follows the message again.
  fillChip('');
  await new Promise((r) => setTimeout(r, 300));
  expect(chipInput().value).toBe('');
  blurChip();
  await until(() => chipInput().value === 'Paste bug', 'following the message again');
  expect(chip().getAttribute('data-compose-thread-name')).toBe('auto');

  // A draft of a chip that follows the message keeps no name; reopened, it is worked out again.
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-keep]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  let saved = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; thread_name?: string }[] }).drafts;
  expect(saved.map((d) => d.thread_name)).toEqual([undefined]);
  act(() => (el.querySelector('[data-drafts-nav]') as HTMLButtonElement).click());
  await until(() => el.querySelectorAll('[data-draft-id]').length === 1, 'the draft row');
  act(() => (el.querySelector('.ib-draft-open') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('[data-compose-to="ses_named"]') != null && chipInput()?.value === 'Paste bug', 'reopened, named from the message');

  // A typed name is kept by the draft, as typed.
  fillChip('Kanban board');
  key('Escape');
  act(() => (dialog()!.querySelector('[data-compose-keep]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'compose closed');
  saved = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { drafts: { id: string; thread_name?: string }[] }).drafts;
  expect(saved.map((d) => d.thread_name)).toEqual(['Kanban board']);
});

test.skipIf(!hasDom)('Send: a typed name goes as thread_name (checked first), the chip that follows the message as thread_name_auto; the row has either as its chip', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  type('I want to explore what adding a board would look like. Kanban specifically.');
  await until(() => chipInput().value === 'Kanban board', 'named from the message');
  // Not a valid name: Send sends nothing and says why on the chip.
  fillChip('Kanban\u202eboard');
  posted = [];
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => chipError() !== null, 'the error on the chip');
  expect(chipError()!.textContent).toBe('Thread name must not contain bidirectional control characters.');
  expect(chip().hasAttribute('data-invalid')).toBe(true);
  expect(chipInput().getAttribute('aria-invalid')).toBe('true');
  expect(dialog()!.querySelector('[data-compose-error]')).toBeNull();
  expect(posted.some((p) => p.path === '/api/inbox/messages')).toBe(false);
  // Typing again clears it; ⌘↵ in the chip sends.
  fillChip('Kanban board');
  expect(chipError()).toBeNull();
  act(() => {
    chipInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => dialog() === null, 'sent');
  let send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body.thread_name).toBe('Kanban board');
  expect(send.body.thread_name_auto).toBeUndefined();

  // The chip left as it was goes as compose's suggestion.
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  type('can you fix the paste bug in the reply box');
  await until(() => chipInput().value === 'Paste bug', 'named from the message');
  posted = [];
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');
  send = posted.find((p) => p.path === '/api/inbox/messages')!;
  expect(send.body).toMatchObject({ thread_name: 'Paste bug', thread_name_auto: true });

  const sections = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections;
  const rows = sections.flatMap((s) => s.threads);
  expect(rows.find((t) => t.subject === 'I want to explore what adding a board would look like')!.thread_name).toBe('Kanban board');
  expect(rows.find((t) => t.subject === 'can you fix the paste bug in the reply box')!.thread_name).toBe('Paste bug');
});

test.skipIf(!hasDom)('a typed name another open thread has: refused (409) and said on the chip; a suggestion another thread has is simply not used; the limit counts characters, not UTF-16 units', async () => {
  await poll('ses_taken', 'claude-code', projects[0]!);
  // An open thread of the project already has the name.
  const { serverSession } = JSON.parse((await loopback('/api/inbox/settings')).text) as { serverSession: string };
  const first = await loopback(
    '/api/inbox/messages',
    'POST',
    JSON.stringify({ serverSession, to: { session: 'ses_taken' }, body: 'Relay retry budget, five a minute.', idempotency_key: 'taken-1', thread_name: 'Relay budget' }),
  );
  expect(first.status).toBe(200);

  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  // 130 emoji (260 UTF-16 units): kept to 120 characters, as the server counts them.
  fillChip('🎉'.repeat(130));
  expect([...chipInput().value].length).toBe(120);

  type('Another idea about the relay.');
  fillChip('relay  BUDGET');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => chipError() !== null, 'the refusal on the chip');
  expect(chipError()!.textContent).toContain('Another open thread in this project has this name.');
  expect(chip().hasAttribute('data-invalid')).toBe(true);
  expect(dialog()!.querySelector('[data-compose-error]')).toBeNull();
  // Editing the name clears the mark and the message.
  fillChip('Relay budget v2');
  expect(chip().hasAttribute('data-invalid')).toBe(false);
  expect(chipError()).toBeNull();
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent');

  // A suggestion that is taken: the Send goes, the thread just has no name yet (its agent names it).
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  type('Thinking about the relay budget again.');
  await until(() => chipInput().value === 'Relay budget', 'a taken suggestion');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'sent anyway');
  const rows = (JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] }).sections.flatMap((s) => s.threads);
  expect(rows.find((t) => t.subject === 'Thinking about the relay budget again')!.thread_name ?? null).toBeNull();
});

test.skipIf(!hasDom)('dictation or a paste into the chip that cannot be a name is never cut short: it goes to the message, and the chip says so', async () => {
  await poll('ses_named', 'claude-code', projects[0]!);
  const el = await renderApp();
  await openCompose(el);
  await until(() => dialog()!.querySelector('[data-compose-to^="ses_"]') !== null, 'To prefilled');
  type('Kanban board idea.');
  await until(() => chipInput().value !== '', 'named');
  const before = chipInput().value;
  const paste = (text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => (kind === 'text/plain' ? text : ''), files: [], items: [], types: ['text/plain'] } });
    act(() => {
      chipInput().focus();
      chipInput().dispatchEvent(event);
    });
    return event;
  };
  // A dictated sentence far longer than a name: into the message, whole.
  const long = 'And the columns should follow every state a thread can be in, '.repeat(3).trim();
  const event = paste(long);
  expect(event.defaultPrevented).toBe(true);
  const text = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  await until(() => text.value === `Kanban board idea. ${long}`, 'the words in the message');
  expect(chipInput().value).toBe(before);
  expect(dialog()!.querySelector('[data-compose-thread-name-note]')!.textContent).toBe('Too long for a name, so it went into your message.');
  // A paste with a line break goes there too; a short one is the name's.
  paste('Line one\nline two');
  await until(() => text.value.endsWith('\nLine one\nline two'), 'the lines in the message');
  // A dictated sentence of eight words or more is a sentence, not a name, even when it would fit.
  expect(paste('this is a sentence the person said out loud').defaultPrevented).toBe(true);
  expect(paste('Short').defaultPrevented).toBe(false);
});
