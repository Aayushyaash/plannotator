/**
 * Links inside an attached HTML page: the whole window (InboxApp) over a REAL
 * Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `html-links` mode). The page's
 * bridge is played by a `link-click` message from the page's own frame, as
 * the bridge posts it in Interact. What is proved: a sibling page that is not
 * attached opens read-only over the page with Back, the note and Open in new
 * tab, and Back returns; a link to another attachment of the thread opens it
 * in the pane as a new history entry; an image in the folder that is not
 * attached opens in the lightbox through the page's asset route; another
 * site opens a new tab; a PDF says why it does not open.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const LINK_CLICK = 'plannotator-bridge-link-click';

type World = { project: string; htmlLinks: { thread: string; ids: Record<string, string> } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedOpen: typeof window.open;
let opened: string[] = [];

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

const TESTS = 6;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-htmllinks-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'html-links'], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      HOME: dir,
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
  opened = [];
  savedOpen = window.open;
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  window.open = savedOpen;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
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

async function renderSheet() {
  window.location.hash = `#thread=${world.htmlLinks.thread}&file=${world.htmlLinks.ids['SHEET.html']}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-view .ib-htmlframe iframe') !== null, 'the attached page');
  return host;
}

/** The page's bridge relaying a link click (in Interact), from the frame it lives in. */
async function clickLink(frame: HTMLIFrameElement, href: string) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: LINK_CLICK, href } }));
  });
}

const sheetFrame = (el: ParentNode) => el.querySelector<HTMLIFrameElement>('.ib-view .ib-htmlframe iframe')!;

test.skipIf(!hasDom)('a sibling page that is not attached opens read-only over the page, with Back, and Back returns', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'B-cards.html#pr1');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
  const band = el.querySelector<HTMLElement>('.ib-linkband')!;
  expect(band.querySelector('[data-linked-back]')!.textContent).toContain('Back to SHEET.html');
  expect(band.querySelector('[data-linked-note]')!.textContent).toContain('is not attached, so comments are off');
  expect(band.querySelector<HTMLAnchorElement>('[data-linked-open-tab]')!.getAttribute('href')).toMatch(/^\/api\/html-assets\/[A-Za-z0-9_-]+\/B-cards\.html$/);
  // The attached page stays mounted under it, hidden and inert.
  const covered = el.querySelector<HTMLElement>('.ib-htmlframe.ib-covered')!;
  expect(covered.hasAttribute('inert')).toBe(true);
  // The page is in the route (one history entry each), and the panel says comments are off on it.
  expect(new URLSearchParams(window.location.hash.slice(1)).get('linked')).toBe('B-cards.html#pr1');
  expect(el.querySelector('[data-annotation-panel-note]')?.textContent).toBe('Off on B-cards.html');
  // The empty panel says where comments go, never "Select text to annotate" beside "Off on".
  expect(el.querySelector('.ib-view')!.textContent).not.toContain('Select text to annotate');
  expect(el.querySelector('.ib-view')!.textContent).toContain('Comment on SHEET.html, not on this page');
  // From the sibling, a further sibling: Back names the page before it.
  const linkedFrame = el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!;
  await clickLink(linkedFrame, 'C-between.html');
  await until(() => el.querySelector('[data-linked-page="C-between.html"]') !== null, 'the second linked page');
  expect(el.querySelector('[data-linked-back]')!.textContent).toContain('Back to B-cards.html');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-linked-back]')!.click());
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'back on B');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-linked-back]')!.click());
  await until(() => el.querySelector('[data-linked-page]') === null, 'back on the attached page');
  expect(el.querySelector('.ib-htmlframe.ib-covered')).toBeNull();
  // A link from a sibling back to the attached page clears the stack too.
  await clickLink(sheetFrame(el), 'B-cards.html');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page again');
  await clickLink(el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!, 'SHEET.html');
  await until(() => el.querySelector('[data-linked-page]') === null, 'home');
});

test.skipIf(!hasDom)('Escape from the pane steps back one linked page, before the rest of the ladder', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'B-cards.html');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
  await clickLink(el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!, 'C-between.html');
  await until(() => el.querySelector('[data-linked-page="C-between.html"]') !== null, 'the second linked page');
  const pane = el.querySelector<HTMLElement>('.ib-view')!;
  const escape = async () => {
    pane.focus();
    await act(async () => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  };
  await escape();
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'back on B');
  await escape();
  await until(() => el.querySelector('[data-linked-page]') === null, 'back on the attached page');
  // The file is still open: the ladder's next rung is the file's own, not the linked page's.
  expect(el.querySelector(`[data-attachment-pane="${world.htmlLinks.ids['SHEET.html']}"]`)).not.toBeNull();
});

test.skipIf(!hasDom)('a link to another attachment of the thread opens it in the pane', async () => {
  const el = await renderSheet();
  const imageId = world.htmlLinks.ids['a.png']!;
  await clickLink(sheetFrame(el), 'frames/a.png');
  await until(() => window.location.hash.includes(`file=${imageId}`), 'the route on the image');
  await until(() => el.querySelector(`[data-attachment-pane="${imageId}"]`) !== null, 'the image in the pane');
});

test.skipIf(!hasDom)('an image in the folder that is not attached opens in the lightbox through the asset route', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'frames/b.png');
  await until(() => document.querySelector('[data-image-lightbox]') !== null, 'the lightbox');
  const img = document.querySelector<HTMLImageElement>('[data-image-lightbox] img')!;
  expect(img.getAttribute('src')).toMatch(/^\/api\/html-assets\/[A-Za-z0-9_-]+\/frames\/b\.png$/);
  // The pane still shows the attached page.
  expect(el.querySelector(`[data-attachment-pane="${world.htmlLinks.ids['SHEET.html']}"]`)).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[data-image-lightbox]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
});

test.skipIf(!hasDom)('another site opens a new tab', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'https://example.com/x');
  expect(opened).toEqual(['https://example.com/x']);
});

test.skipIf(!hasDom)('a file that is neither attached nor a page or image says why, never silent', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'report.pdf');
  await until(() => el.querySelector('[data-link-note="shown"]') !== null, 'the note');
  expect(el.querySelector('[data-link-note]')!.textContent).toContain('report.pdf is not attached to this thread');
  expect(el.querySelector('[data-step-live]')!.textContent === '' || el.querySelector('[data-step-live]')!.textContent!.includes('report.pdf')).toBe(true);
  // Outside the page's folder.
  await clickLink(sheetFrame(el), '../../elsewhere.html');
  await until(() => el.querySelector('[data-link-note]')!.textContent!.includes('outside this page'), 'the outside note');
});
