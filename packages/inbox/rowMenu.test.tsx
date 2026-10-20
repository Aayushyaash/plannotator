/**
 * The thread row's right-click menu as the window draws it: the whole window
 * (InboxApp) over a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts). What is proved: a right-click (and the
 * keyboard's `contextmenu`) on a row opens the menu without opening the
 * thread, its items in order, Copy link writing the thread's address (the
 * Inbox's one address plus `#thread=`) and Copy thread ID its id, each with
 * a toast, a copy that fails saying so, Mark read and Archive with the
 * row's own toasts, Move back on a row marked read, Escape putting focus
 * back on the row, the row's muted background while the menu is open, and a
 * touch never opening it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { threadLink, rowMenuActions } = await import('./rowMenu');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
type World = { project: string; stopped: string; waiting: string; mixed: string; same: string; picked: string; filed: string };
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedClipboard: PropertyDescriptor | undefined;
let fetched: string[] = [];
let posted: { path: string; body: Record<string, unknown> }[] = [];
let clipboard: string[] = [];
let clipboardFails = false;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function serverSections(): Promise<Map<string, string>> {
  const model = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  return new Map(model.sections.flatMap((s) => s.threads.map((r) => [r.thread_id, s.id] as const)));
}

const TESTS = 7;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-rowmenu-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const lines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
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
  ids = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    else fetched.push(path);
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboardFails) throw new Error('denied');
        clipboard.push(text);
      },
    },
  });
  // The legacy fallback fails too when the clipboard is denied (happy-dom has no copy command).
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
  fetched = [];
  posted = [];
  clipboard = [];
  clipboardFails = false;
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
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  document.body.innerHTML = '';
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
  await until(() => !!rowButton(ids.waiting), 'the list');
  // The settings carry the Inbox's one address.
  await until(() => fetched.includes('/api/inbox/settings'), 'the settings');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`);
const rowWrap = (id: string) => document.querySelector<HTMLElement>(`.ib-lbody [data-row="${id}"]`);
const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) => el.textContent?.trim());
const item = (action: string) => menu()?.querySelector<HTMLElement>(`[data-row-action="${action}"]`) ?? null;
const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');

async function rightClick(el: HTMLElement, init: MouseEventInit & { pointerType?: string } = {}) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200, ...init }));
  });
}

async function openMenu(id: string) {
  await rightClick(rowButton(id)!);
  await until(() => menu()?.getAttribute('data-row-menu') === id, 'the menu');
}

async function choose(action: string) {
  const el = item(action)!;
  await act(async () => {
    el.click();
  });
}

test('the link is the Inbox one address plus #thread=, and the items follow the row', () => {
  expect(threadLink('msg_1', { url: 'http://localhost:4321/', via: 'local' }, 'http://127.0.0.1:4321')).toBe('http://localhost:4321/#thread=msg_1');
  // Over the tailnet the page's own origin: the address the device it is on can open.
  expect(threadLink('msg_1', { url: 'http://localhost:4321/', via: 'tailnet' }, 'https://box.ts.net:4321')).toBe('https://box.ts.net:4321/#thread=msg_1');
  expect(threadLink('msg_1', null, 'http://localhost:4321')).toBe('http://localhost:4321/#thread=msg_1');
  const base = {
    thread_id: 'msg_1',
    section: 'waiting',
    unseen: 0,
    answered_not_sent: false,
    resolved_at: null,
    read_at: null,
    back_from_archive: false,
    agent_after_archive: false,
  } as unknown as Parameters<typeof rowMenuActions>[0];
  expect(rowMenuActions(base, true)).toEqual(['copy-link', 'copy-id', 'read', 'archive']);
  expect(rowMenuActions({ ...base, section: 'quiet', read_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-link', 'copy-id', 'unread', 'archive']);
  expect(rowMenuActions({ ...base, section: 'sent' }, true)).toEqual(['copy-link', 'copy-id', 'archive']);
  // Archived (held in place while a thread is open): only the copies.
  expect(rowMenuActions({ ...base, section: 'quiet', resolved_at: '2026-10-20T00:00:00Z' }, true)).toEqual(['copy-link', 'copy-id']);
});

test.skipIf(!hasDom)('a right-click opens the menu on that row, without opening the thread; Copy link writes its address', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  expect(items()).toEqual(['Copy link', 'Copy thread ID', 'Mark read', 'Archive']);
  expect(menu()!.querySelector('[role="separator"]')).not.toBeNull();
  // The row keeps a muted background while its menu is open; nothing opened, nothing selected.
  expect(rowWrap(ids.waiting)!.hasAttribute('data-menu')).toBe(true);
  expect(window.location.hash).not.toContain('thread=');
  expect(document.querySelector('.ib-sel')).toBeNull();
  await choose('copy-link');
  await until(() => !!toast(), 'the toast');
  expect(clipboard).toEqual([`http://localhost:${port}/#thread=${ids.waiting}`]);
  expect(toast()!.textContent).toContain('Link copied');
  expect(window.location.hash).not.toContain('thread=');
  await until(() => !rowWrap(ids.waiting)!.hasAttribute('data-menu'), 'the muted background to go');
});

test.skipIf(!hasDom)('Copy thread ID writes the id; a copy that fails says so', async () => {
  await renderApp();
  await openMenu(ids.stopped);
  await choose('copy-id');
  await until(() => toast()?.textContent?.includes('Thread ID copied') === true, 'the toast');
  expect(clipboard).toEqual([ids.stopped]);
  clipboardFails = true;
  await openMenu(ids.stopped);
  await choose('copy-link');
  await until(() => toast()?.textContent?.includes("Couldn't copy") === true, 'the failure');
  expect(clipboard).toEqual([ids.stopped]);
});

test.skipIf(!hasDom)('Mark read moves the row to Quiet with its toast; the menu then offers Move back', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  await choose('read');
  await until(() => !!toast(), 'the toast');
  expect(posted.some((p) => p.path === `/api/inbox/threads/${ids.waiting}/read`)).toBe(true);
  // No thread open: the row moved, and the toast names it.
  expect(toast()!.textContent).toContain('Moved to Quiet');
  expect((await serverSections()).get(ids.waiting)).toBe('quiet');
  // Quiet is folded: open it to reach the row.
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-section-id="quiet"] button.ib-band')!.click();
  });
  await until(() => !!rowButton(ids.waiting), 'the row in Quiet');
  await openMenu(ids.waiting);
  expect(items()).toEqual(['Copy link', 'Copy thread ID', 'Move back', 'Archive']);
  await choose('unread');
  await until(async () => (await serverSections()).get(ids.waiting) === 'waiting', 'the row back');
});

test.skipIf(!hasDom)('Archive takes the row out of the list with the Archived toast and its Undo', async () => {
  await renderApp();
  await openMenu(ids.waiting);
  await choose('archive');
  await until(() => !!toast(), 'the toast');
  expect(posted.some((p) => p.path === `/api/inbox/messages/${ids.waiting}/resolve` && p.body.resolved === true)).toBe(true);
  expect(toast()!.textContent).toContain('Archived');
  await until(() => !rowButton(ids.waiting), 'the row to leave');
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => !!rowButton(ids.waiting), 'the row back');
});

test.skipIf(!hasDom)('Escape closes the menu and puts focus back on the row; the keyboard opens it too', async () => {
  await renderApp();
  const row = rowButton(ids.mixed)!;
  act(() => row.focus());
  // Shift+F10 on the focused row: the list sends the row a `contextmenu` (macOS browsers send none).
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.mixed, 'the menu');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !menu(), 'the menu to close');
  await until(() => document.activeElement === rowButton(ids.mixed), 'focus on the row');
  // Tab leaves the menu for the row too.
  await act(async () => {
    rowButton(ids.mixed)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => menu()?.getAttribute('data-row-menu') === ids.mixed, 'the menu again');
  await act(async () => {
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  await until(() => !menu(), 'the menu to close on Tab');
  await until(() => document.activeElement === rowButton(ids.mixed), 'focus on the row after Tab');
  // Nothing opened.
  expect(window.location.hash).not.toContain('thread=');
});

test.skipIf(!hasDom)('a touch never opens it, and outside the rows the browser keeps its own menu', async () => {
  await renderApp();
  const row = rowButton(ids.same)!;
  await act(async () => {
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  });
  const touchEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => {
    row.dispatchEvent(touchEvent);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(menu()).toBeNull();
  expect(touchEvent.defaultPrevented).toBe(false);
  const band = document.querySelector<HTMLElement>('.ib-band')!;
  const onBand = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  await act(async () => {
    band.dispatchEvent(onBand);
  });
  expect(menu()).toBeNull();
  expect(onBand.defaultPrevented).toBe(false);
});
