/**
 * How an attachment opens (fileView.ts, approval "inbox-side-by-side"): the
 * decision table (address × choice × kind × room), and the remembered choice
 * through the storage seam.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import {
  FILE_VIEW_COOKIE,
  fileViewFor,
  kindDefaultView,
  openingView,
  parseFileView,
  readFileViewChoice,
  writeFileViewChoice,
  type FileView,
} from './fileView';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  setStorageBackend({
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  });
});
afterEach(() => resetStorageBackend());

const html = { kind: 'html' } as const;
const markdown = { kind: 'markdown' } as const;
const code = { kind: 'code' } as const;
const attachedImage = { kind: 'image' } as const;
/** An image a message's text shows (`ref`, the src as written). */
const inTextImage = { kind: 'image', ref: 'shots/after.png' } as const;
const video = { kind: 'video' } as const;
const pdf = { kind: 'pdf' } as const;
/** A kind this build does not know reads as `file`. */
const unknownKind = { kind: 'hologram' } as unknown as typeof pdf;

test("before any choice, today's rule: an HTML page and an image from a message's text open full screen, the rest side by side", () => {
  const rule = (a: Parameters<typeof kindDefaultView>[0]) => kindDefaultView(a);
  expect(rule(html)).toBe('full');
  expect(rule(inTextImage)).toBe('full');
  for (const a of [markdown, code, attachedImage, video, pdf, unknownKind]) expect(rule(a)).toBe('side');
});

test('the decision table: room, then the address, then the choice, then the rule', () => {
  const kinds = [html, markdown, code, attachedImage, inTextImage, video, pdf, unknownKind];
  const views: (FileView | null)[] = [null, 'full', 'side'];
  for (const attachment of kinds) {
    for (const address of views) {
      for (const choice of views) {
        // No room for two panes (a phone, a stacked window): always full screen, whatever anything says.
        expect(fileViewFor(attachment, { address, choice, narrow: true })).toBe('full');
        const expected = address ?? choice ?? kindDefaultView(attachment);
        expect(fileViewFor(attachment, { address, choice, narrow: false })).toBe(expected);
      }
    }
  }
});

test('the choice applies to every kind: Side by side keeps HTML and in-text images beside the thread, Full screen takes documents full screen', () => {
  for (const attachment of [html, inTextImage, markdown, pdf]) {
    expect(fileViewFor(attachment, { address: null, choice: 'side', narrow: false })).toBe('side');
    expect(fileViewFor(attachment, { address: null, choice: 'full', narrow: false })).toBe('full');
  }
});

test('the address wins over the choice (a shared link, a reload, a tile ⋯ pick for one file)', () => {
  expect(fileViewFor(markdown, { address: 'full', choice: 'side', narrow: false })).toBe('full');
  expect(fileViewFor(html, { address: 'side', choice: 'full', narrow: false })).toBe('side');
});

test('only the two views parse; anything else in the address or the cookie counts as none', () => {
  expect(parseFileView('full')).toBe('full');
  expect(parseFileView('side')).toBe('side');
  for (const junk of [null, undefined, '', 'FULL', 'beside', 'full ', 'side;x']) expect(parseFileView(junk)).toBeNull();
});

test('the remembered choice: written, read back, forgotten; a stored value that is not a view reads as none', () => {
  expect(readFileViewChoice()).toBeNull();
  expect(openingView(html)).toBe('full');
  expect(openingView(markdown)).toBe('side');

  writeFileViewChoice('side');
  expect(store.get(FILE_VIEW_COOKIE)).toBe('side');
  expect(readFileViewChoice()).toBe('side');
  expect(openingView(html)).toBe('side');
  expect(openingView(inTextImage)).toBe('side');

  writeFileViewChoice('full');
  expect(openingView(markdown)).toBe('full');

  // Undo of a first pick: back to no choice, and today's rule again.
  writeFileViewChoice(null);
  expect(store.has(FILE_VIEW_COOKIE)).toBe(false);
  expect(openingView(markdown)).toBe('side');
  expect(openingView(html)).toBe('full');

  store.set(FILE_VIEW_COOKIE, 'sideways');
  expect(readFileViewChoice()).toBeNull();
  expect(openingView(html)).toBe('full');
});
