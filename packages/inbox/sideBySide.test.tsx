/**
 * The side-by-side view, named and remembered (approval "inbox-side-by-side",
 * fileView.ts): InboxApp over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts in its `open-in` mode, whose
 * thread carries page.html, plan.md, build.zip, shot.png). The header's
 * "Side by side | Full screen" switch and full screen's "Side by side" save
 * the choice (with the window's toast and its Undo); Escape never does; the
 * choice opens every kind; the address (`view=`) wins over it; a tile's ⋯
 * opens one file one way without saving anything.
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

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const CHROME_COOKIE = 'plannotator-html-chrome';
const DRAWER_COOKIE = 'plannotator-inbox-file-comments';
const VIEW_COOKIE = 'plannotator-inbox-file-view';

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

const TESTS = 8;

beforeAll(async () => {
  if (!hasDom) return;
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-side-by-side-dom-')));
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
  document.cookie = `${DRAWER_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
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
  document.cookie = `${DRAWER_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${VIEW_COOKIE}=; path=/; max-age=0`;
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
const inFullScreen = () => view()?.hasAttribute('data-full-view') === true;
async function openTile(name: string) {
  const tile = host!.querySelector<HTMLElement>(`.ib-attachments [data-attachment-id="${world.openIn.ids[name]}"], [data-attachment-id="${world.openIn.ids[name]}"]`)!;
  await act(async () => tile.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids[name], `${name} open`);
}
/** Close the file beside the thread. */
async function close() {
  await act(async () => host!.querySelector<HTMLButtonElement>('.ib-vhead [aria-label^="Close "]')!.click());
}


/** The remembered view (a removed cookie can linger empty here: that is none). */
const choice = () => document.cookie.split('; ').find((c) => c.startsWith(`${VIEW_COOKIE}=`))?.slice(VIEW_COOKIE.length + 1) || null;
const addressView = () => new URLSearchParams(window.location.hash.slice(1)).get('view');
const toast = () => host!.querySelector<HTMLElement>('.ib-toast');
const liveSaid = () => [...host!.querySelectorAll<HTMLElement>('[data-inbox-live]')].map((n) => n.textContent ?? '').join(' ');
const sideButton = () => host!.querySelector<HTMLButtonElement>('.ib-vhead [data-view-side]');
const fullButton = () => host!.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]');
const escapeOnPane = async () => {
  const pane = view()!;
  pane.focus();
  await act(async () => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
};
async function tileMenu(name: string): Promise<HTMLElement> {
  const id = world.openIn.ids[name]!;
  await until(() => host!.querySelector(`button[data-open-in-more="${id}"]`) !== null, `${name}'s ⋯`);
  await act(async () => host!.querySelector<HTMLButtonElement>(`button[data-open-in-more="${id}"]`)!.click());
  await until(() => document.querySelector(`[data-open-in-menu="${id}"]`) !== null, `${name}'s menu`);
  return document.querySelector<HTMLElement>(`[data-open-in-menu="${id}"]`)!;
}
const openAsItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[data-open-as]')].map((i) => `${i.getAttribute('data-open-as')}:${i.textContent?.trim()}`);

test.skipIf(!hasDom)('the header switch: a press on its pressed half saves side by side, the frame unchanged; again, no toast; Full screen saves full screen; Undo puts the old choice and the view back', async () => {
  const el = await renderThread();
  await openTile('plan.md');
  expect(inFullScreen()).toBe(false);
  expect(choice()).toBeNull();
  const group = el.querySelector('.ib-vhead [data-view-switch]')!;
  expect(group.getAttribute('role')).toBe('group');
  expect(sideButton()!.getAttribute('aria-pressed')).toBe('true');
  expect(fullButton()!.getAttribute('aria-pressed')).toBe('false');
  expect(sideButton()!.textContent).toBe('Side by side');
  expect(fullButton()!.textContent).toBe('Full screen');

  // The pressed half: side by side becomes the choice, with the toast; the file stays where it is.
  await act(async () => sideButton()!.click());
  await until(() => toast() !== null, 'the side-by-side toast');
  expect(choice()).toBe('side');
  expect(inFullScreen()).toBe(false);
  expect(addressView()).toBe('side');
  expect(toast()!.querySelector('.ib-tlead')!.textContent).toBe('Files open side by side now');
  expect(toast()!.querySelector('.ib-tdetail')!.textContent).toBe('until you choose Full screen');
  await act(async () => toast()!.querySelector<HTMLButtonElement>('[data-toast-dismiss]')!.click());
  await until(() => toast() === null, 'the toast gone');

  // Picking the view already remembered says nothing a second time.
  await act(async () => sideButton()!.click());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(toast()).toBeNull();
  expect(choice()).toBe('side');

  // Full screen: the choice, the toast, and the live region.
  await act(async () => fullButton()!.click());
  await until(inFullScreen, 'full screen');
  expect(choice()).toBe('full');
  expect(addressView()).toBe('full');
  await until(() => toast() !== null, 'the full-screen toast');
  expect(toast()!.querySelector('.ib-tlead')!.textContent).toBe('Files open full screen now');
  expect(toast()!.querySelector('.ib-tdetail')!.textContent).toBe('until you choose Side by side');
  await until(() => liveSaid().includes('Files open full screen now, until you choose Side by side.'), 'the toast said in the live region');

  // Undo: side by side remembered again, and this file back beside the thread.
  await act(async () => toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click());
  await until(() => !inFullScreen(), 'beside the thread again');
  expect(choice()).toBe('side');
  expect(addressView()).toBe('side');
});

test.skipIf(!hasDom)('Undo after another file opened puts back only the choice: the file open by then keeps its frame', async () => {
  await renderThread();
  await openTile('plan.md');
  await act(async () => fullButton()!.click());
  await until(inFullScreen, 'full screen');
  expect(choice()).toBe('full');
  await until(() => toast() !== null, 'the toast');
  // Another file, opened by the new choice: full screen.
  await openTile('shot.png');
  await until(inFullScreen, 'the image full screen');
  await act(async () => toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click());
  expect(choice()).toBeNull();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  expect(view()?.getAttribute('data-attachment-pane')).toBe(world.openIn.ids['shot.png']!);
  expect(inFullScreen()).toBe(true);
  expect(addressView()).toBe('full');
});

test.skipIf(!hasDom)("Side by side, once chosen, opens every kind beside the thread, HTML included; Full screen, once chosen, takes a document full screen", async () => {
  document.cookie = `${VIEW_COOKIE}=side; path=/`;
  await renderThread();
  await openTile('page.html');
  expect(inFullScreen()).toBe(false);
  expect(addressView()).toBe('side');
  await close();
  await until(() => view() === null, 'closed');
  document.cookie = `${VIEW_COOKIE}=full; path=/`;
  await openTile('plan.md');
  await until(inFullScreen, 'plan.md full screen');
  expect(addressView()).toBe('full');
});

test.skipIf(!hasDom)("Escape's last rung puts the file beside the thread without saving anything", async () => {
  await renderThread();
  await openTile('page.html');
  await until(inFullScreen, 'the page full screen');
  expect(choice()).toBeNull();
  // The pen first (Annotate → Interact), then the file goes beside the thread.
  for (let i = 0; i < 4 && inFullScreen(); i++) await escapeOnPane();
  await until(() => !inFullScreen(), 'beside the thread');
  expect(choice()).toBeNull();
  expect(toast()).toBeNull();
  expect(document.activeElement === sideButton()).toBe(true);
  // The address carries it, so a reload keeps it beside.
  expect(addressView()).toBe('side');
  // Nothing was saved, so the page opened again follows today's rule: full screen.
  await close();
  await until(() => view() === null, 'closed');
  await openTile('page.html');
  await until(inFullScreen, 'the page full screen by the rule');
  expect(choice()).toBeNull();
});

test.skipIf(!hasDom)("a comment card in the reply box opens its file in the view it is in: a one-off view from a tile's ⋯ stays", async () => {
  // A comment waiting on plan.md (seeded through the Inbox's own route).
  const saved = await loopback(
    '/api/inbox/annotations',
    'POST',
    JSON.stringify({
      attachment_id: world.openIn.ids['plan.md'],
      version: 'current',
      annotation: { id: 'ann-sbs-1', blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Is this the order?', originalText: 'Plan', createdA: Date.now() },
    }),
  );
  expect(saved.status).toBe(200);
  document.cookie = `${VIEW_COOKIE}=side; path=/`;
  const el = await renderThread();
  // plan.md full screen for this once, from its tile's ⋯.
  const menu = await tileMenu('plan.md');
  await act(async () => menu.querySelector<HTMLElement>('[data-open-as="full"]')!.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['plan.md'], 'plan.md open');
  await until(inFullScreen, 'full screen for this file');
  // The reply box (its foot reads "Edit draft" while a comment waits), its chip, then the comment's card.
  const opener = () => [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => ['Reply', 'Edit draft'].includes(b.textContent?.trim() ?? ''));
  await until(() => opener() !== undefined, 'the reply box button');
  await act(async () => opener()!.click());
  await until(() => el.querySelector('[data-annotations-chip]') !== null, 'the annotations chip');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-annotations-chip]')!.click());
  await until(() => document.querySelector('[data-annotation-row="ann-sbs-1"] .ib-af') !== null, 'the comment card');
  await act(async () => document.querySelector<HTMLButtonElement>('[data-annotation-row="ann-sbs-1"] .ib-af')!.click());
  await until(() => new URLSearchParams(window.location.hash.slice(1)).get('at') === 'ann-sbs-1', 'the comment shown');
  expect(inFullScreen()).toBe(true);
  expect(addressView()).toBe('full');
  expect(choice()).toBe('side');
});

test.skipIf(!hasDom)("a tile's ⋯ opens that file side by side or full screen and never changes the choice; a download has no such items", async () => {
  document.cookie = `${VIEW_COOKIE}=side; path=/`;
  await renderThread();
  const pageMenu = await tileMenu('page.html');
  expect(openAsItems(pageMenu)).toEqual(['side:Open side by side', 'full:Open full screen']);
  await act(async () => pageMenu.querySelector<HTMLElement>('[data-open-as="full"]')!.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['page.html'], 'the page open');
  await until(inFullScreen, 'full screen for this file');
  expect(addressView()).toBe('full');
  expect(choice()).toBe('side');
  expect(toast()).toBeNull();

  // Back beside the thread through Escape (not saved), then the image from its ⋯, side by side.
  for (let i = 0; i < 4 && inFullScreen(); i++) await escapeOnPane();
  await until(() => !inFullScreen(), 'beside the thread');
  document.cookie = `${VIEW_COOKIE}=full; path=/`;
  const shotMenu = await tileMenu('shot.png');
  expect(openAsItems(shotMenu)).toEqual(['side:Open side by side', 'full:Open full screen']);
  await act(async () => shotMenu.querySelector<HTMLElement>('[data-open-as="side"]')!.click());
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['shot.png'], 'the image open');
  expect(inFullScreen()).toBe(false);
  expect(choice()).toBe('full');

  // A zip only downloads: its ⋯ holds Open in, nothing about views.
  const zipMenu = await tileMenu('build.zip');
  expect(openAsItems(zipMenu)).toEqual([]);
  expect(zipMenu.querySelector('[data-open-in-item="reveal"]')).not.toBeNull();
});

test.skipIf(!hasDom)('the address wins: a link with view=full opens a document full screen, one with view=side keeps HTML beside; a link without it uses the choice', async () => {
  document.cookie = `${VIEW_COOKIE}=side; path=/`;
  window.location.hash = `#thread=${world.openIn.thread}&file=${world.openIn.ids['plan.md']}&view=full`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => view() !== null, 'the file');
  await until(inFullScreen, 'plan.md full screen from the address');
  expect(choice()).toBe('side');
  // A step keeps the view the address carries, whatever the next file's kind.
  await act(async () => {
    view()!.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
  });
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['page.html'], 'the step');
  expect(inFullScreen()).toBe(true);
  expect(addressView()).toBe('full');
  // A link with no view (search, an agent's link): the choice, side by side, even for HTML.
  await act(async () => {
    window.location.hash = `#thread=${world.openIn.thread}&file=${world.openIn.ids['page.html']}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => !inFullScreen(), 'the page by the choice');
});

test.skipIf(!hasDom)('a step beside the thread keeps the file beside it, even onto an HTML page (no choice yet)', async () => {
  await renderThread();
  await openTile('plan.md');
  expect(inFullScreen()).toBe(false);
  // The pane's file list steps from inside the file; page.html is before plan.md in the thread.
  await act(async () => {
    view()!.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }));
  });
  await until(() => view()?.getAttribute('data-attachment-pane') === world.openIn.ids['page.html'], 'the step');
  expect(inFullScreen()).toBe(false);
  expect(addressView()).toBe('side');
  expect(choice()).toBeNull();
});
