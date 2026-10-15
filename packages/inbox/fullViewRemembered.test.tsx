/**
 * Full view's remembered choice (approval "inbox-full-view", decision 2): the
 * whole window (InboxApp) over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts in its `open-in` mode, whose
 * thread carries page.html, plan.md, build.zip, shot.png). An HTML file opens
 * full screen straight into full view while the choice plan review shares
 * (the `plannotator-html-chrome` cookie, `toolsHidden`, hidden by default)
 * says so; the eye writes that same cookie both ways; Full screen on an HTML
 * file follows it; a markdown file opens beside the thread and never writes it.
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
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { getHtmlChromeState, saveHtmlChromeState } = (hasDom ? await import('@plannotator/ui/utils/htmlChrome') : {}) as typeof import('@plannotator/ui/utils/htmlChrome');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const CHROME_COOKIE = 'plannotator-html-chrome';

type World = { project: string; openIn: { thread: string; ids: Record<string, string> } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

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

const TESTS = 3;

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-fullview-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'open-in'], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_TAILSCALE: '',
      OPEN_IN_PLATFORM: 'mac',
      HOME: dir,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    },
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
  world = worlds.shift()!;
  document.cookie = `${CHROME_COOKIE}=; path=/; max-age=0`;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
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
  document.cookie = `${CHROME_COOKIE}=; path=/; max-age=0`;
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderThread() {
  window.location.hash = `#thread=${world.openIn.thread}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector(`[data-attachment-id="${world.openIn.ids['page.html']}"]`) !== null, 'the thread and its tiles');
  return host;
}

const view = () => host!.querySelector<HTMLElement>('.ib-view');
const inFullView = () => view()?.hasAttribute('data-full-view') === true;
async function openTile(name: string) {
  const tile = host!.querySelector<HTMLElement>(`.ib-attachments [data-attachment-id="${world.openIn.ids[name]}"], [data-attachment-id="${world.openIn.ids[name]}"]`)!;
  await act(async () => tile.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids[name], `${name} open`);
}
async function close() {
  const button = host!.querySelector<HTMLButtonElement>('.ib-vhead [aria-label^="Close "]') ?? null;
  if (button) await act(async () => button.click());
  else await act(async () => host!.querySelector<HTMLButtonElement>('[data-full-view-eye]')!.click());
}

test.skipIf(!hasDom)('an HTML file opens straight into full view by default; the eye shows the tools and writes the cookie plan review reads', async () => {
  // Plan review's own halves of the record (its sidebar and its annotations drawer) are left as they were.
  saveHtmlChromeState({ sidebarOpen: true, panelOpen: true, toolsHidden: true });
  const el = await renderThread();
  await openTile('page.html');
  await until(inFullView, 'full view');
  expect(view()!.classList.contains('ib-full')).toBe(true);
  expect(el.querySelector('.ib-vhead')).toBeNull();
  expect(el.querySelector('[data-full-view-pen]')).not.toBeNull();

  await act(async () => el.querySelector<HTMLButtonElement>('[data-full-view-eye]')!.click());
  await until(() => !inFullView(), 'the tools back');
  expect(view()!.classList.contains('ib-full')).toBe(true);
  expect(getHtmlChromeState()).toEqual({ sidebarOpen: true, panelOpen: true, toolsHidden: false });

  // Remembered: the next HTML file opens full screen with the tools.
  await close();
  await until(() => view() === null, 'the file closed');
  await openTile('page.html');
  expect(inFullView()).toBe(false);
  expect(view()!.classList.contains('ib-full')).toBe(true);

  // And the other way: the header eye hides them again, written back.
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-html-tools-toggle]')!.click());
  await until(inFullView, 'full view again');
  expect(getHtmlChromeState().toolsHidden).toBe(true);
});

test.skipIf(!hasDom)('a choice saved by plan review (tools shown) is followed; Exit / Full screen on the HTML file follows it again', async () => {
  saveHtmlChromeState({ ...getHtmlChromeState(), toolsHidden: false });
  const el = await renderThread();
  await openTile('page.html');
  expect(inFullView()).toBe(false);
  const fullButton = () => [...el.querySelectorAll<HTMLButtonElement>('.ib-vhead button')].find((b) => /full screen/i.test(b.textContent ?? ''))!;
  await act(async () => fullButton().click());
  expect(view()!.classList.contains('ib-full')).toBe(false);
  // Now hidden is the shared choice: Full screen opens straight into full view.
  saveHtmlChromeState({ ...getHtmlChromeState(), toolsHidden: true });
  await act(async () => fullButton().click());
  await until(inFullView, 'full view from Full screen');
});

test.skipIf(!hasDom)('a markdown file opens beside the thread; its eye goes full view without touching the shared choice', async () => {
  const el = await renderThread();
  await openTile('plan.md');
  expect(view()!.classList.contains('ib-full')).toBe(false);
  expect(inFullView()).toBe(false);
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-html-tools-toggle]')!.click());
  await until(inFullView, 'full view');
  expect(view()!.classList.contains('ib-full')).toBe(true);
  expect(document.cookie.includes(CHROME_COOKIE)).toBe(false);
  // A step to the HTML file keeps full view (the thread's order: page.html is before plan.md).
  await act(async () => {
    view()!.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
  });
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['page.html'], 'the step');
  expect(inFullView()).toBe(true);
});
