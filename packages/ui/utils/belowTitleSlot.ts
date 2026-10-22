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

/** Marks the slot's wrapper. Presence is enough for a host's CSS. */
export const BELOW_TITLE_SLOT_ATTRIBUTE = 'data-viewer-below-title';

/**
 * The attribute's value on the wrapper the Viewer draws itself: random per
 * page load, so a `<div data-viewer-below-title>` an author writes as raw
 * HTML in a document (the sanitizer keeps `data-*`) is never taken for the
 * slot. Only a direct child of the root carrying exactly this value counts.
 */
export const BELOW_TITLE_SLOT_MARKER = `slot-${Math.random().toString(36).slice(2, 12)}`;

/** web-highlighter's sentinels (`ROOT_IDX`, `UNKNOWN_IDX`): never translated. */
const isElementIndex = (index: number): boolean => Number.isInteger(index) && index >= 0;

interface TextMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

/** Which end of a selection a meta is; decides where one inside the slot goes. */
export type MetaEdge = 'start' | 'end';

/** The Viewer's own slot wrapper in `root`, or null. */
const findSlot = (root: Element): Element | null => {
  for (const child of Array.from(root.children)) {
    if (child.getAttribute(BELOW_TITLE_SLOT_ATTRIBUTE) === BELOW_TITLE_SLOT_MARKER) return child;
  }
  return null;
};

/** web-highlighter's own parent rule: skip its highlight wrappers. */
const originParent = (node: Node): HTMLElement | null => {
  let parent = node.parentElement;
  while (parent && parent.dataset?.highlightId) parent = parent.parentElement;
  return parent;
};

/** Text that is never part of a comment (the highlighter's exclusions). */
const isExcludedText = (node: Text): boolean =>
  node.parentElement?.closest('.annotation-exclude, .annotation-toolbar, button, .katex, .math-annotatable') != null;

/** The text offset of `text`'s end (or start) inside `parent`, counted the
 *  way web-highlighter counts it: every text node under `parent` in order. */
const offsetIn = (parent: Element, text: Text, atEnd: boolean): number => {
  const walker = parent.ownerDocument.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === text) return offset + (atEnd ? text.length : 0);
    offset += (node as Text).length;
  }
  return offset;
};

/**
 * A boundary that landed inside the slot, moved out of it: an end goes back
 * to the end of the last comment text before the slot, a start forward to
 * the beginning of the first after it. Returned as a LIVE meta.
 */
const snapOutOfSlot = <M extends TextMeta>(root: Element, slot: Element, meta: M, edge: MetaEdge): M => {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let chosen: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.length || slot.contains(text) || isExcludedText(text)) continue;
    const before = (slot.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (edge === 'end' && before) chosen = text;
    if (edge === 'start' && !before) { chosen = text; break; }
  }
  const parent = chosen ? originParent(chosen) : null;
  if (!chosen || !parent || !root.contains(parent) || parent === root) return meta;
  const index = Array.from(root.getElementsByTagName(parent.tagName)).indexOf(parent);
  if (index < 0) return meta;
  return { ...meta, parentTagName: parent.tagName, parentIndex: index, textOffset: offsetIn(parent, chosen, edge === 'end') };
};

/**
 * Live index → the index the element has with the slot's elements left out.
 * A boundary inside the slot (a selection from the title that ends in it) is
 * first moved out of it, so a stored meta never points into the slot.
 */
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M, edge: MetaEdge): M;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined, edge: MetaEdge): M | undefined;
export function metaWithoutBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined, edge: MetaEdge): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex)) return meta;
  const slot = findSlot(root);
  if (!slot) return meta;
  let live = meta;
  const parent = root.getElementsByTagName(live.parentTagName)[live.parentIndex];
  if (!parent) return meta;
  if (slot.contains(parent)) {
    live = snapOutOfSlot(root, slot, live, edge);
    if (live === meta) return meta;
  }
  const list = root.getElementsByTagName(live.parentTagName);
  let skipped = 0;
  for (let i = 0; i < live.parentIndex; i++) {
    if (slot.contains(list[i]!)) skipped++;
  }
  return skipped === 0 ? live : { ...live, parentIndex: live.parentIndex - skipped };
}

/** Slot-free index → the live index of that element (the slot's skipped). */
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M): M;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined;
export function metaWithBelowTitle<M extends TextMeta>(root: Element | null, meta: M | undefined): M | undefined {
  if (!root || !meta || !isElementIndex(meta.parentIndex)) return meta;
  const slot = findSlot(root);
  if (!slot) return meta;
  const list = root.getElementsByTagName(meta.parentTagName);
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    if (slot.contains(list[i]!)) continue;
    if (seen === meta.parentIndex) return i === meta.parentIndex ? meta : { ...meta, parentIndex: i };
    seen++;
  }
  // Past the end: unchanged, so the restore fails exactly as it would have.
  return meta;
}

/**
 * Move a selection's ends out of the Viewer's slot before the highlighter
 * reads it: an end inside the slot goes back to the end of the last comment
 * text before the slot, a start inside it forward to the first after it. A
 * range that lies wholly inside the slot (or would collapse) is left alone;
 * it paints nothing. Returns whether the range changed. No slot in `root`:
 * never changes anything.
 */
export function snapRangeOutOfBelowTitle(root: Element | null, range: Range): boolean {
  if (!root) return false;
  const slot = findSlot(root);
  if (!slot) return false;
  const startIn = slot.contains(range.startContainer);
  const endIn = slot.contains(range.endContainer);
  if (startIn === endIn) return false;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let chosen: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.length || slot.contains(text) || isExcludedText(text)) continue;
    const before = (slot.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (endIn && before) chosen = text;
    if (startIn && !before) { chosen = text; break; }
  }
  if (!chosen) return false;
  const next = range.cloneRange();
  if (endIn) next.setEnd(chosen, chosen.length);
  else next.setStart(chosen, 0);
  if (next.collapsed) return false;
  if (endIn) range.setEnd(chosen, chosen.length);
  else range.setStart(chosen, 0);
  return true;
}
