/**
 * The `Viewer` `belowTitle` host slot, and how stored text positions stay
 * independent of it.
 *
 * web-highlighter stores a comment's position as `{ parentTagName,
 * parentIndex, textOffset }`, where `parentIndex` is the index of the parent
 * element among EVERY element of that tag under the annotation root (the
 * Viewer's `<article>`). The slot sits inside that root, right after the
 * title, so whatever a host renders in it (a `<p>`, a `<span>`, an `<a>`)
 * would renumber every later element of the same tag. That would make a
 * comment saved with the slot present resolve onto other text without it (or
 * with different slot contents), and the other way round.
 *
 * So the hook translates at its two edges: a new selection's metas are
 * rewritten to the index the element would have WITHOUT the slot
 * (`metaWithoutBelowTitle`), and a stored meta is mapped back to the live
 * element before `fromStore` (`metaWithBelowTitle`). With no slot in the root
 * both are the identity, so a document without one stores and restores
 * exactly as before.
 */

/** Marks the slot's wrapper. Also how the translation finds it. */
export const BELOW_TITLE_SLOT_ATTRIBUTE = 'data-viewer-below-title';

const SLOT_SELECTOR = `[${BELOW_TITLE_SLOT_ATTRIBUTE}]`;

/** web-highlighter's sentinels (`ROOT_IDX`, `UNKNOWN_IDX`): never translated. */
const isElementIndex = (index: number): boolean => Number.isInteger(index) && index >= 0;

interface TextMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

const inSlot = (root: Element, element: Element): boolean => {
  const slot = element.closest(SLOT_SELECTOR);
  return slot !== null && slot !== root && root.contains(slot);
};

const rootHasSlot = (root: Element): boolean => root.querySelector(SLOT_SELECTOR) !== null;

/** Live index → the index the element has with the slot's elements left out. */
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M): M;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex) || !rootHasSlot(root)) return meta;
  const list = root.getElementsByTagName(meta.parentTagName);
  const target = list[meta.parentIndex];
  // A position inside the slot has no slot-free index; leave it alone (no
  // comment is ever made there, the slot is `annotation-exclude`).
  if (!target || inSlot(root, target)) return meta;
  let skipped = 0;
  for (let i = 0; i < meta.parentIndex; i++) {
    if (inSlot(root, list[i]!)) skipped++;
  }
  return skipped === 0 ? meta : { ...meta, parentIndex: meta.parentIndex - skipped };
}

/** Slot-free index → the live index of that element (the slot's skipped). */
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M): M;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex) || !rootHasSlot(root)) return meta;
  const list = root.getElementsByTagName(meta.parentTagName);
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (inSlot(root, list[i]!)) continue;
    if (seen === meta.parentIndex) return i === meta.parentIndex ? meta : { ...meta, parentIndex: i };
    seen++;
  }
  // Past the end: unchanged, so the restore fails exactly as it would have.
  return meta;
}
