/**
 * The document's text size in plan review and annotate (Settings → Display →
 * Text size, #2066): the body text size in px, 15 by default (the document as
 * it has always been drawn). Headings, lists, code, tables and question cards
 * keep their proportions to it.
 *
 * The app puts it on the document element (`applyDocumentTextSize`, through
 * `hooks/useDocumentTextSize`) and packages/ui/theme.css scales the blocks of
 * a document container (`data-doc-text-root`) from `--doc-text-scale`. At the
 * default nothing is set, so the page is exactly today's. Only the document's
 * blocks scale: the header, panels, badges, menus and popouts keep their size.
 * Raw HTML pages and diagrams draw themselves and do not follow it.
 *
 * Deliberately free of imports so the settings registry can read it on every
 * surface (the guides.show viewer included).
 */

/** The steps Settings offers, in px of body text. */
export const DOCUMENT_TEXT_SIZE_OPTIONS = [13, 15, 17, 19, 21] as const;

export type DocumentTextSize = (typeof DOCUMENT_TEXT_SIZE_OPTIONS)[number];

/** Today's body text size: paragraphs are `text-[15px]`. */
export const DEFAULT_DOCUMENT_TEXT_SIZE: DocumentTextSize = 15;

/** The attribute index.css keys on; present only away from the default. */
export const DOCUMENT_TEXT_SIZE_ATTRIBUTE = 'data-doc-text-size';

/** The multiplier index.css scales by (size / 15). */
export const DOCUMENT_TEXT_SCALE_PROPERTY = '--doc-text-scale';

/** Only an offered step is a size; anything else reads as the default. */
export function isDocumentTextSize(value: unknown): value is DocumentTextSize {
  return (DOCUMENT_TEXT_SIZE_OPTIONS as readonly unknown[]).includes(value);
}

/** The scale a size draws the document at, relative to today's. */
export function documentTextScale(size: DocumentTextSize): number {
  return size / DEFAULT_DOCUMENT_TEXT_SIZE;
}

/**
 * Put `size` on `root` (the document element). At the default both the
 * attribute and the property are removed, so nothing in index.css applies.
 */
export function applyDocumentTextSize(root: HTMLElement, size: number): void {
  if (!isDocumentTextSize(size) || size === DEFAULT_DOCUMENT_TEXT_SIZE) {
    root.removeAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE);
    root.style.removeProperty(DOCUMENT_TEXT_SCALE_PROPERTY);
    return;
  }
  root.setAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE, String(size));
  root.style.setProperty(DOCUMENT_TEXT_SCALE_PROPERTY, String(documentTextScale(size)));
}
