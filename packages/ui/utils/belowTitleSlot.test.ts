/**
 * The position translation behind `Viewer` `belowTitle` (DOM-gated,
 * DOM_TESTS=1). Failures to catch: a root with no slot is not left exactly as
 * is; the two directions disagree; web-highlighter's sentinel indexes are
 * rewritten; a position inside the slot is renumbered.
 */
import { afterEach, expect, test } from 'bun:test';
import { BELOW_TITLE_SLOT_ATTRIBUTE, metaWithBelowTitle, metaWithoutBelowTitle } from './belowTitleSlot';

const hasDom = typeof document !== 'undefined';

afterEach(() => { if (hasDom) document.body.replaceChildren(); });

function build(withSlot: boolean): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = [
    '<h1>T</h1>',
    withSlot ? `<div ${BELOW_TITLE_SLOT_ATTRIBUTE}=""><p>a</p><p>b</p></div>` : '',
    '<p>one</p><p>two</p><p>three</p>',
  ].join('');
  document.body.appendChild(root);
  return root;
}

const meta = (parentIndex: number) => ({ parentTagName: 'P', parentIndex, textOffset: 1 });

test.skipIf(!hasDom)('no slot: both directions return the very same object', () => {
  const root = build(false);
  for (const i of [0, 1, 2, -1, -2]) {
    const m = meta(i);
    expect(metaWithoutBelowTitle(root, m)).toBe(m);
    expect(metaWithBelowTitle(root, m)).toBe(m);
  }
  expect(metaWithoutBelowTitle(root, undefined)).toBeUndefined();
});

test.skipIf(!hasDom)('with a slot: live index ↔ slot-free index, round trip', () => {
  const root = build(true);
  const live = [...root.getElementsByTagName('p')];
  for (const text of ['one', 'two', 'three']) {
    const liveIndex = live.findIndex((p) => p.textContent === text);
    const stored = metaWithoutBelowTitle(root, meta(liveIndex));
    expect(stored.parentIndex).toBe(['one', 'two', 'three'].indexOf(text));
    expect(metaWithBelowTitle(root, stored).parentIndex).toBe(liveIndex);
  }
  // Sentinels, positions inside the slot and past the end are left alone.
  for (const m of [meta(-1), meta(-2), meta(0), meta(1)]) expect(metaWithoutBelowTitle(root, m)).toBe(m);
  const past = meta(9);
  expect(metaWithBelowTitle(root, past)).toBe(past);
});
