/**
 * The agents the person tagged in a sent reply, painted as the composer
 * paints them (approval "inbox-tag-agents"): `@Pi` in the primary color on a
 * light wash, the agent's mark drawn over the `@` (the approved shot 5's
 * chip) in a layer the host owns. Painted with the CSS Custom Highlight API,
 * like the skill references (skillHighlight.ts), so the Viewer's DOM is never changed. The
 * tokens are the labels the reply's own tags carry (what was sent). Where the
 * API is missing (an older browser, the DOM tests) nothing is painted and the
 * words read as plain text.
 */

/** The highlight's name in `CSS.highlights` (inbox.css styles `::highlight(ib-tag-ref)`). */
export const TAG_REF_HIGHLIGHT = 'ib-tag-ref';

/** Text the tokens are never found in: code, a message's head row (folded or open), and form fields. */
const SKIP = 'pre, code, [data-skills-line], [data-fold-head], [data-open-head], script, style, textarea';

/**
 * Where `@<label>` appears in `text`: at a word start (the composer's email
 * guard), the longest label first so "Claude Code (another session)" wins
 * over "Claude Code".
 */
export function tagTokenSpans(text: string, labels: readonly string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const sorted = [...new Set(labels.filter((l) => l.trim() !== ''))].sort((a, b) => b.length - a.length);
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i > 0 && !/\s|[(["'“‘]/u.test(text.charAt(i - 1))) continue;
    const label = sorted.find((l) => text.startsWith(l, i + 1));
    if (!label) continue;
    const end = i + 1 + label.length;
    // The label ends a word: not "@Pilot" for "Pi".
    if (end < text.length && /[\p{L}\p{N}_]/u.test(text.charAt(end))) continue;
    out.push({ start: i, end });
    i = end - 1;
  }
  return out;
}

/** One token under `root`: the range of the whole `@<label>`, the range of its `@`, and the label. */
export interface TagReference {
  range: Range;
  at: Range;
  label: string;
}

/** The tokens under `root` (never inside `skip`, the marks' own layer). */
export function tagReferences(root: Node, labels: readonly string[], skip?: Element | null): TagReference[] {
  const out: TagReference[] = [];
  if (labels.length === 0) return out;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) || (skip && skip.contains(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (const span of tagTokenSpans(node.data, labels)) {
      const range = doc.createRange();
      range.setStart(node, span.start);
      range.setEnd(node, span.end);
      const at = doc.createRange();
      at.setStart(node, span.start);
      at.setEnd(node, span.start + 1);
      out.push({ range, at, label: node.data.slice(span.start + 1, span.end) });
    }
  }
  return out;
}

/** The ranges of the tokens under `root`. */
export function tagReferenceRanges(root: Node, labels: readonly string[]): Range[] {
  return tagReferences(root, labels).map((r) => r.range);
}

interface HighlightApi {
  highlights: { set(name: string, value: unknown): void; delete(name: string): void };
  Highlight: new (...ranges: Range[]) => { priority: number };
}

function api(): HighlightApi | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightApi['highlights'] } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightApi['Highlight'] }).Highlight;
  return css?.highlights && typeof Highlight === 'function' ? { highlights: css.highlights, Highlight } : null;
}

/** The `@` of each token, drawn clear (inbox.css) so the agent's mark sits in its place, as the approved shot 5 draws the chip. */
export const TAG_AT_HIGHLIGHT = 'ib-tag-at';

const painted = new Map<string, TagReference[]>();

function publish(registry: HighlightApi): void {
  const refs = [...painted.values()].flat();
  if (refs.length === 0) {
    registry.highlights.delete(TAG_REF_HIGHLIGHT);
    registry.highlights.delete(TAG_AT_HIGHLIGHT);
    return;
  }
  // Below search's landing highlight (priority 0), as the skill references are; the `@` above the token's colour.
  const tokens = new registry.Highlight(...refs.map((r) => r.range));
  tokens.priority = -2;
  registry.highlights.set(TAG_REF_HIGHLIGHT, tokens);
  const ats = new registry.Highlight(...refs.map((r) => r.at));
  ats.priority = -1;
  registry.highlights.set(TAG_AT_HIGHLIGHT, ats);
}

/** Where one agent's mark sits over a token's `@`, in the layer's (else `root`'s) coordinates. */
export interface TagMarkPlace {
  label: string;
  left: number;
  top: number;
  size: number;
}

/**
 * Paint one message's tag tokens under `root`, again whenever its DOM or its
 * size changes, and report where each token's `@` is (`onMarks`), so the
 * host draws the agent's mark there in a layer of its own (`layer`, inside
 * `root`, never walked). Where the Highlight API is missing nothing is
 * painted and no mark is placed: the words read as plain text. Returns the cleanup.
 */
export function paintTagReferences(
  key: string,
  root: HTMLElement,
  labels: readonly string[],
  options: { layer?: HTMLElement | null; onMarks?: (marks: TagMarkPlace[]) => void } = {},
): () => void {
  const registry = api();
  if (!registry || labels.length === 0) return () => {};
  const { layer = null, onMarks } = options;
  let disposed = false;
  const paint = () => {
    if (disposed) return;
    const refs = tagReferences(root, labels, layer);
    painted.set(key, refs);
    publish(registry);
    if (!onMarks) return;
    // Measured from the layer's own box (a zero-height block in `root`), so `root` needs no positioning of its own.
    const box = (layer ?? root).getBoundingClientRect();
    onMarks(
      refs.flatMap((ref) => {
        const rect = ref.at.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return [];
        // The mark fits the `@`'s own box (nothing around it moves), left in it so a hair of space stays before the name.
        const size = Math.round(Math.min(14, Math.max(10, rect.width - 2)));
        return [
          {
            label: ref.label,
            left: Math.round(rect.left - box.left),
            top: Math.round(rect.top - box.top + (rect.height - size) / 2),
            size,
          },
        ];
      }),
    );
  };
  paint();
  let frame = 0;
  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  };
  const observer = new MutationObserver((records) => {
    // The marks' own layer changing is not a reason to measure again.
    if (layer && records.every((r) => layer.contains(r.target))) return;
    schedule();
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(root);
  void root.ownerDocument?.fonts?.ready.then(schedule).catch(() => {});
  return () => {
    disposed = true;
    observer.disconnect();
    resize?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    painted.delete(key);
    publish(registry);
    onMarks?.([]);
  };
}
