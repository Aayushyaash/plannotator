/**
 * Where the skill picker sits when it opens at the caret (compose's message,
 * a tall field in a modal dialog). The picker is portaled into the dialog and
 * hangs off a box laid over the caret's line; this file measures that line
 * and keeps the box inside the part of the field that is on screen.
 *
 * Why not the field's own box: the menu is `absolute` against its wrapper, so
 * in a tall field it opened under the whole field, inside `.ib-cp-body`
 * (a scroll container), and the dialog's footer covered it.
 */

export interface VerticalBox {
  top: number;
  bottom: number;
}

export interface AnchorBox extends VerticalBox {
  left: number;
  width: number;
}

/**
 * The caret's line in a textarea, in viewport coordinates: a hidden mirror
 * with the textarea's metrics lays out the text before the caret and a span
 * holding the rest (so the line wraps exactly as the textarea's does), and the
 * span's top is the line's top. Null when the textarea is not laid out.
 */
export function caretLineRect(textarea: HTMLTextAreaElement, position = textarea.selectionStart ?? textarea.value.length): VerticalBox | null {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  const rect = textarea.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const style = view.getComputedStyle(textarea);
  const mirror = doc.createElement('div');
  const copy = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'direction',
  ] as const;
  for (const key of copy) (mirror.style as unknown as Record<string, string>)[key] = style[key] as string;
  const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
  // clientWidth leaves out a classic scrollbar, so the mirror wraps where the textarea does.
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${textarea.clientWidth + borderX}px`;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = style.wordBreak;
  mirror.style.overflow = 'hidden';
  mirror.style.height = 'auto';
  mirror.setAttribute('aria-hidden', 'true');
  const value = textarea.value;
  const at = Math.max(0, Math.min(position, value.length));
  mirror.textContent = value.slice(0, at);
  const marker = doc.createElement('span');
  marker.textContent = value.slice(at) || '.';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  try {
    const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.2;
    const top = rect.top + px(style.borderTopWidth) + marker.offsetTop - textarea.scrollTop;
    return { top, bottom: top + lineHeight };
  } finally {
    mirror.remove();
  }
}

/**
 * The part of `el` on screen: its box cut by every ancestor that clips
 * (overflow other than visible) below `stopAt`.
 */
export function visibleBox(el: Element, stopAt: Element | null): VerticalBox & { left: number; right: number } {
  const r = el.getBoundingClientRect();
  const box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  const view = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node && node !== stopAt; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (!style) break;
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = node.getBoundingClientRect();
    box.top = Math.max(box.top, c.top);
    box.bottom = Math.min(box.bottom, c.bottom);
    box.left = Math.max(box.left, c.left);
    box.right = Math.min(box.right, c.right);
  }
  return box;
}

/**
 * The box the picker hangs off: the caret's line, held inside the visible
 * part of the field (a line scrolled out of view pins to the field's edge, so
 * the menu stays next to the field), across the field's width. Pure.
 */
export function caretAnchor(line: VerticalBox, visible: VerticalBox, field: { left: number; width: number }): AnchorBox {
  const height = Math.max(0, line.bottom - line.top);
  const lo = visible.top;
  const hi = Math.max(lo, visible.bottom - height);
  const top = Math.min(Math.max(line.top, lo), hi);
  return { top, bottom: top + Math.min(height, Math.max(0, visible.bottom - visible.top)), left: field.left, width: field.width };
}

function px(value: string | null | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}
