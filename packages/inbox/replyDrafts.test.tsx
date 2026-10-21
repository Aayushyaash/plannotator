/**
 * Reply drafts in the window (approval "inbox-reply-drafts", variant Label):
 * the words typed in a thread's reply box are kept as a server draft while
 * typing, come back (without taking focus) when the thread opens again,
 * survive Cancel, go with Discard and with the Send that carries them; the
 * list row says "Draft · Your reply" (or "Draft · 1 pick"), and the Drafts
 * page lists the threads holding unsent work above the messages.
 *
 * The window over a REAL Inbox (tests/helpers/inbox-dom-server.ts), its
 * fetches carried over loopback. DOM-gated: runs under DOM_TESTS=1
 * (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unsentReply } from './unsent';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string; picked: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '', picked: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** How long the reply route's answer is held back (the delayed-reply probe), in ms. */
let replyDelay = 0;
/** The window's event streams (a stand-in EventSource), to hand it an `event: drafts`. */
let streams: { listeners: Map<string, ((event: { data: string }) => void)[]> }[] = [];
function emit(type: string, data: unknown) {
  for (const stream of streams) for (const listener of stream.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
}
const lines: string[] = [];

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

const TESTS = 20;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-replydrafts-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let buffer = '';
  let first: string | null = null;
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) {
          if (first === null) first = line;
          else lines.push(line);
        }
        at = buffer.indexOf('\n');
      }
    }
  })();
  for (let i = 0; i < 400 && first === null; i++) await new Promise((r) => setTimeout(r, 25));
  if (first === null) throw new Error('the Inbox did not start');
  const started = JSON.parse(first) as { port: number; worlds: World[] };
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
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    // Only the reply's answer is held back: the request itself has reached the server.
    if (replyDelay > 0 && method === 'POST' && path.endsWith('/reply')) await new Promise((r) => setTimeout(r, replyDelay));
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  streams = [];
  (globalThis as Record<string, unknown>).EventSource = class {
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor() {
      streams.push(this);
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
  };
  replyDelay = 0;
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

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const serverDraft = async (threadId: string) =>
  (JSON.parse((await loopback(`/api/inbox/threads/${threadId}/draft`)).text) as { draft: { body: string; updated_at: string } | null }).draft;

const leave = () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
};

test.skipIf(!hasDom)('typed words are saved while typing, and come back in the box when the thread opens again, without taking focus', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind, but index the changelog too');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind, but index the changelog too', 'the draft saved');
  // The soft pill with when it was saved, and Discard.
  await until(() => el.querySelector('[data-draft-head] .ib-draft-pill') !== null, 'the Draft pill');
  expect(el.querySelector('[data-draft-head] .ib-draft-saved')?.textContent).toMatch(/^Saved \d{1,2}:\d{2} [AP]M$/);
  expect(el.querySelector('[data-draft-discard]')?.textContent).toBe('Discard');
  leave();

  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => (again.querySelector('textarea') as HTMLTextAreaElement | null)?.value === 'Pagefind, but index the changelog too', 'the words back');
  expect(document.activeElement).not.toBe(again.querySelector('textarea'));
});

test.skipIf(!hasDom)('leaving the thread before the pause in typing still saves the words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  type(el, 'Orama.');
  leave();
  await until(async () => (await serverDraft(world.waiting))?.body === 'Orama.', 'the draft saved as the thread closed');
});

test.skipIf(!hasDom)('Cancel keeps the words: the foot says "Draft · Your reply", Send and Edit draft; Edit draft brings them back', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind.', 'the draft saved on Cancel');
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot says Draft');
  expect(el.querySelector('[data-draft-foot]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft Your reply');
  expect(el.querySelector('.ib-pfoot')?.textContent).not.toContain('Not sent');
  button(el, 'Send');
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Pagefind.');
});

test.skipIf(!hasDom)('Discard drops the draft, here and on the server', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Never mind this.');
  await until(() => el.querySelector('[data-draft-discard]') !== null, 'Discard');
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(() => el.querySelector('textarea') === null, 'the box closed');
  await until(async () => (await serverDraft(world.waiting)) === null, 'the draft gone');
  button(el, 'Reply');
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
});

test.skipIf(!hasDom)('the Send that carries the words clears the draft (clear_draft on that reply)', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind, thanks.');
  await until(async () => (await serverDraft(world.waiting)) !== null, 'the draft saved');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  // The draft the words were saved as, by its updated_at: the server clears that draft only.
  expect(reply.body).toMatchObject({ words: 'Pagefind, thanks.' });
  expect(reply.body.clear_draft).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await serverDraft(world.waiting)).toBeNull();
});

test.skipIf(!hasDom)('a Send pressed before the pause in typing, whose answer is slow, never brings the words back as a draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  // The reply's answer comes 800 ms late; Send goes well inside the 500 ms pause before the save.
  replyDelay = 800;
  type(el, 'Sent quickly.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Sent quickly.');
  // Past any save the typing scheduled: the server holds no draft, and the window shows none.
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
  // The save that ran before the Send is the only one; none came after it.
  const saves = posted.filter((p) => /\/draft$/.test(p.path));
  const replyAt = posted.indexOf(reply);
  expect(saves.every((p) => posted.indexOf(p) < replyAt)).toBe(true);
});

test.skipIf(!hasDom)('the foot\'s Send (box closed) carries the draft as it is now, and a newer draft from another window survives a Send of older words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind.', 'the draft saved on Cancel');
  // Another window types over the draft; no event reaches this one.
  const mine = (await serverDraft(world.waiting))!;
  const theirs = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Orama, after all.', base: mine.updated_at }));
  expect(theirs.status).toBe(200);
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot says Draft');
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Orama, after all.');
  await until(async () => (await serverDraft(world.waiting)) === null, 'the draft it carried cleared');
});

test.skipIf(!hasDom)('an `event: drafts` for the open thread reads its draft again: Edit draft brings back the other window\'s words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the draft saved on Cancel');
  const mine = (await serverDraft(world.waiting))!;
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Newer words.', base: mine.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await settle();
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Newer words.');
});

test.skipIf(!hasDom)('the list says "Draft · Your reply" and "Draft · 1 pick"; the Drafts row counts them and its page lists them above the messages', async () => {
  // Words typed in this world's waiting thread, through the window's route.
  const saved = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Pagefind.', base: null }));
  expect(saved.status).toBe(200);
  const el = await renderApp('');
  const label = (id: string) => el.querySelector(`[data-thread-id="${id}"] [data-draft-label]`)?.textContent?.replace(/\s+/g, ' ').trim();
  await until(() => label(world.waiting) === 'Draft · Your reply', 'the waiting row');
  expect(label(world.picked)).toBe('Draft · 1 pick');
  const nav = el.querySelector('[data-drafts-nav]')!;
  const replies = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { replies: { thread_id: string }[] }).replies;
  expect(replies.map((r) => r.thread_id)).toContain(world.waiting);
  expect(nav.textContent).toBe(`Drafts${replies.length}`);
  act(() => (nav as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-reply-draft="${world.waiting}"]`) !== null, 'the Drafts page');
  const row = el.querySelector(`[data-reply-draft="${world.waiting}"]`)!;
  expect(row.textContent).toContain('Pagefind.');
  expect(row.querySelector('[data-draft-label]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft · Your reply');
  expect(el.querySelector('.ib-drafts-h')?.textContent).toBe('Replies not sent');
  act(() => (row.querySelector('.ib-draft-open') as HTMLButtonElement).click());
  await until(() => window.location.hash.includes(`thread=${world.waiting}`), 'the thread opened');
});

test.skipIf(!hasDom)('a pick not sent: the card says "Draft", its footer "in your draft", the foot "Draft · 1 pick"', async () => {
  const el = await renderApp(`#thread=${world.picked}`);
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot');
  expect(el.querySelector('[data-draft-foot]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft 1 pick');
  expect(el.textContent).toMatch(/Picked \d{1,2}:\d{2} [AP]M · in your draft/);
  expect(el.textContent).not.toContain('Not sent');
});

test.skipIf(!hasDom)('typing during a slow Send never brings back a draft holding the sent words: the box is read-only while it goes', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the words saved');
  // The reply's answer is held 1.5 s; the person keeps typing meanwhile.
  replyDelay = 1500;
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the reply posted');
  expect((el.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true);
  type(el, 'First words. And more.');
  // The box keeps the words the Send carries.
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('First words.');
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // No save went after the reply.
  const reply = posted.findIndex((p) => p.path.endsWith('/reply'));
  expect(posted.slice(reply).some((p) => /\/draft$/.test(p.path))).toBe(false);
  // The next visit shows no draft.
  leave();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...again.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  await settle();
  expect(again.querySelector('textarea')).toBeNull();
  expect(again.querySelector('[data-draft-foot]')).toBeNull();
});

test.skipIf(!hasDom)('a Send that fails gives the thread back: the words are saved again', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Kept after a failure.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept after a failure.', 'the words saved');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/reply')) return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
    return real(input, init);
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !(el.querySelector('textarea') as HTMLTextAreaElement).readOnly && el.textContent!.includes('down'), 'the failure');
  globalThis.fetch = real;
  type(el, 'Kept after a failure, edited.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept after a failure, edited.', 'saved again after the failure');
});

test.skipIf(!hasDom)('another window sent the words: this window\'s next save is refused, never re-creates the draft, and keeps its words as not saved', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the words saved');
  // Window A sends those words (its Send clears the draft it saved).
  const mine = (await serverDraft(world.waiting))!;
  const sent = await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'other-window', words: 'First words.', clear_draft: mine.updated_at }));
  expect(sent.status).toBe(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // This window keeps typing: its save is refused, and it adopts the server's state.
  type(el, 'First words. And more.');
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(el.querySelector('[data-draft-conflict] .ib-draft-saved')?.textContent).toBe('Not saved: this reply was sent or discarded in another window.');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // More typing stays here, not saved.
  type(el, 'First words. And more, still.');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('First words. And more, still.');
  // Keep mine: the person's choice saves them.
  act(() => (el.querySelector('[data-draft-keep-mine]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words. And more, still.', 'kept on purpose');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
});

/** Open the waiting thread's box with words saved there; answers the draft as the server holds it. */
async function openWithSaved(words: string) {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, words);
  await until(async () => (await serverDraft(world.waiting))?.body === words, 'the words saved');
  await settle();
  return { el, saved: (await serverDraft(world.waiting))! };
}
const box = (el: HTMLElement) => el.querySelector('textarea') as HTMLTextAreaElement | null;
const liveText = (el: HTMLElement) => [...el.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ');

test.skipIf(!hasDom)('event: drafts, sent elsewhere: a box with no edits closes, and the sent words never come back', async () => {
  const { el, saved } = await openWithSaved('First words.');
  // Another window (or the phone, then the computer's window) sends them and clears the draft.
  await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'elsewhere-1', words: 'First words.', clear_draft: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => box(el) === null, 'the box closed');
  expect(liveText(el)).toContain('This reply was sent or discarded in another window.');
  // Opening the box again and typing makes a new draft of new words only.
  act(() => button(el, 'Reply').click());
  await settle();
  expect(box(el)!.value).toBe('');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
});

test.skipIf(!hasDom)('event: drafts, sent elsewhere while this box has edits: the save is refused, the conflict shows, nothing comes back', async () => {
  const { el, saved } = await openWithSaved('First words.');
  type(el, 'First words. And more.');
  await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'elsewhere-2', words: 'First words.', clear_draft: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(box(el)!.value).toBe('First words. And more.');
  // Announced in the thread's live region; the box names the line.
  expect(liveText(el)).toContain('Not saved: this reply was sent or discarded in another window.');
  const line = el.querySelector('[data-draft-conflict] .ib-draft-saved')!;
  expect(line.getAttribute('role')).toBeNull();
  expect(box(el)!.getAttribute('aria-describedby')).toContain(line.id);
  // The restart guard asks while those words are not saved.
  expect(unsentReply()).not.toBeNull();
});

test.skipIf(!hasDom)('event: drafts, the other window typed: a box with no edits takes its words', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => box(el)?.value === 'Theirs.', 'their words in the box');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  // Typing on from there saves over it, as an edit of the newest words.
  type(el, 'Theirs. And mine.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Theirs. And mine.', 'saved on top');
});

test.skipIf(!hasDom)('event: drafts, the other window typed while this box has edits: neither window\'s words are lost; Discard drops only mine', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  type(el, 'Mine, and more.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(el.querySelector('[data-draft-conflict] .ib-draft-saved')?.textContent).toBe('Not saved: this reply changed in another window.');
  await settle(200);
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  expect(box(el)!.value).toBe('Mine, and more.');
  // Two choices only, and their hit areas apart (the gap is wider than both ::after reaches).
  const acts = el.querySelector('[data-draft-conflict] .ib-draft-acts')!;
  expect([...acts.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Keep mine', 'Discard']);
  act(() => (el.querySelector('[data-draft-conflict] [data-draft-discard]') as HTMLButtonElement).click());
  await settle();
  expect(box(el)!.value).toBe('Theirs.');
  expect(document.activeElement).toBe(box(el));
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
});

test.skipIf(!hasDom)('an empty box refused by a newer draft shows nothing and never deletes it', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  // This window empties its box (no event reached it): the delete is refused.
  type(el, '');
  await settle(200);
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
});

test.skipIf(!hasDom)('a Send after a conflict carries this window\'s words and then shows the other window\'s draft', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  type(el, 'Mine, sent.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Mine, sent.');
  expect(reply.body.clear_draft).toBeUndefined();
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot shows the other window\'s draft');
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect(box(el)!.value).toBe('Theirs.');
});

test.skipIf(!hasDom)('a Send whose answer is lost after it went is treated as sent: the words never come back as a draft', async () => {
  const { el } = await openWithSaved('Went, answer lost.');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await real(input, init);
    if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/reply')) throw new TypeError('Failed to fetch');
    return answer;
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('Your reply went, but its answer was lost.'), 'the error saying it went');
  globalThis.fetch = real;
  await settle(200);
  // The draft is gone and nothing saves it again by itself; the box keeps the words for a replaying retry.
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(box(el)!.value).toBe('Went, answer lost.');
  expect(box(el)!.readOnly).toBe(false);
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // Send again: the same key, answered as the reply that went (not sent twice).
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the retry');
  const keys = posted.filter((p) => p.path.endsWith('/reply')).map((p) => p.body.idempotency_key);
  expect(keys.at(-1)).toBe(keys.at(-2));
  const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: { author: { kind: string }; body: string }[] } };
  expect(model.thread.messages.filter((m) => m.author.kind === 'person' && m.body.startsWith('Went, answer lost.'))).toHaveLength(1);
  expect(await serverDraft(world.waiting)).toBeNull();
});
