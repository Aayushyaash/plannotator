import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePeek, type ImagePeekHandle, type ImagePeekRow } from './ImagePeek';

/** One image of a document, for the lightbox's stepping (`images`). */
export interface LightboxImage {
  src: string;
  alt: string;
  /** The heading the image sits under ("Options"), for "2 of 4 · in “Options”" and the peek's rows. */
  section?: string | null;
}

/**
 * The file name an image's src names: the `path` a host route carries
 * (`/api/image?path=…`), else the URL's last segment, else the alt text.
 */
export function lightboxImageName(image: Pick<LightboxImage, 'src' | 'alt'>): string {
  try {
    const base = typeof window !== 'undefined' && /^https?:/.test(window.location.href) ? window.location.href : 'http://localhost/';
    const url = new URL(image.src, base);
    const named = url.searchParams.get('path') ?? (url.protocol === 'data:' || url.protocol === 'blob:' ? '' : url.pathname);
    const last = named.split(/[\\/]/).filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // Not a URL: fall back to the alt text.
  }
  return image.alt || 'Image';
}

/**
 * Every image a rendered document shows, in document order, each with the
 * heading it sits under: what the lightbox steps through (plan review and
 * annotate's light version of the Inbox's one viewer, approval
 * "inbox-image-viewer"). Only images that open the lightbox count
 * (`.cursor-zoom-in`).
 */
export function collectDocumentImages(container: ParentNode | null): LightboxImage[] {
  if (!container) return [];
  const out: LightboxImage[] = [];
  let section: string | null = null;
  for (const el of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, img')) {
    if (el.tagName !== 'IMG') {
      section = (el.textContent ?? '').trim() || section;
      continue;
    }
    const img = el as HTMLImageElement;
    if (!img.classList.contains('cursor-zoom-in')) continue;
    const src = img.getAttribute('src');
    if (!src || out.some((i) => i.src === src)) continue;
    out.push({ src, alt: img.getAttribute('alt') ?? '', section });
  }
  return out;
}

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

/**
 * Overlay for viewing one image enlarged. Shared by the markdown Viewer
 * (clicking an image in a document) and the raw-HTML surface (a link to a
 * local image inside the annotated page).
 *
 * The image is only ever shown through `<img src>`, so an SVG runs no script
 * and cannot reach the page.
 *
 * It is modal for the keyboard. Its keydown listener runs on the CAPTURE phase
 * at the window and stops every key there, so nothing behind it reacts:
 * Escape closes the lightbox before the HTML surface's Esc ladder sees it,
 * and Mod+Enter cannot submit a decision behind it. Focus moves to the
 * overlay when it opens, which also pulls focus out of an HTML page's iframe
 * (whose keys the parent would otherwise never see), and goes back to where
 * it was when it closes.
 *
 * With `images` (two or more) it is the light version of the Inbox's one
 * viewer: full screen, `2 of 4 · in “Options”`, ← → (and `]` `[`) through the
 * document's images, stopping at the ends, Actual size, and the same peek
 * from the pill under the image. No pen, no comments: there the person
 * annotates the document itself. Without `images` it is exactly the single
 * image overlay it always was.
 */
export const ImageLightbox: React.FC<{
  src: string;
  alt: string;
  onClose: () => void;
  /** The document's images in order; with two or more the lightbox steps through them. Additive: absent keeps the single image overlay. */
  images?: readonly LightboxImage[];
}> = ({ src, alt, onClose, images }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stepping = !!images && images.length > 1;
  const [index, setIndex] = useState(() => Math.max(0, images?.findIndex((i) => i.src === src) ?? 0));
  const [fit, setFit] = useState<'fit' | 'actual'>('fit');
  const [peekOpen, setPeekOpen] = useState(false);
  const [endNote, setEndNote] = useState<string | null>(null);
  const [announced, setAnnounced] = useState('');
  const peekRef = useRef<ImagePeekHandle>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = stepping ? images![index]! : { src, alt, section: null };
  const name = lightboxImageName(current);

  const step = (dir: 1 | -1) => {
    if (!stepping) return;
    const next = index + dir;
    if (next < 0 || next >= images!.length) {
      const note = dir > 0 ? 'Last image in this document' : 'First image in this document';
      setEndNote(note);
      setAnnounced(note);
      if (endTimer.current) clearTimeout(endTimer.current);
      endTimer.current = setTimeout(() => setEndNote(null), 1800);
      return;
    }
    go(next);
  };
  const go = (next: number) => {
    setIndex(next);
    setFit('fit');
    const image = images![next]!;
    setAnnounced(`${next + 1} of ${images!.length}, ${lightboxImageName(image)}${image.section ? `, in “${image.section}”` : ''}`);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const peekOpenRef = useRef(peekOpen);
  peekOpenRef.current = peekOpen;

  useEffect(() => () => {
    if (endTimer.current) clearTimeout(endTimer.current);
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (e: KeyboardEvent) => {
      // The peek owns the keys while it is open (it is inside this modal, so they reach it from here).
      if (peekOpenRef.current) {
        e.stopImmediatePropagation();
        if (peekRef.current?.handleKey({ key: e.key, isComposing: e.isComposing })) e.preventDefault();
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault();
        return;
      }
      // Tab stays native: the overlay's own controls take it.
      if (e.key === 'Tab') return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (e.key === 'ArrowRight' || e.key === ']') {
        e.preventDefault();
        stepRef.current(1);
      } else if (e.key === 'ArrowLeft' || e.key === '[') {
        e.preventDefault();
        stepRef.current(-1);
      } else if (e.key === 'ArrowDown' && e.target === pillRef.current) {
        e.preventDefault();
        setPeekOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const rows = useMemo<ImagePeekRow[]>(() => {
    if (!stepping) return [];
    const out: ImagePeekRow[] = [];
    images!.forEach((image, i) => {
      const label = image.section ?? 'Document';
      let row = out.at(-1);
      if (!row || row.label !== label) {
        row = { key: `row-${i}`, label, items: [] };
        out.push(row);
      }
      row.items.push({ key: String(i), name: lightboxImageName(image), thumb: image.src });
    });
    return out;
  }, [stepping, images]);

  if (!stepping) {
    return (
      <div
        ref={overlayRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={alt || 'Image'}
        data-image-lightbox=""
        className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out outline-none"
        onClick={onClose}
      >
        <img
          src={src}
          alt={alt}
          className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
        {alt && (
          <div className="mt-3 text-sm text-white/70 max-w-[90vw] text-center truncate">{alt}</div>
        )}
      </div>
    );
  }

  const total = images!.length;
  const first = index === 0;
  const last = index === total - 1;
  const circle = 'flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm hover:bg-muted disabled:opacity-40 aria-disabled:opacity-35';
  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${name}, image ${index + 1} of ${total}`}
      data-image-lightbox=""
      data-image-lightbox-stepping=""
      className="fixed inset-0 z-[200] flex flex-col bg-background text-foreground outline-none"
    >
      <div className="flex h-14 flex-none items-center gap-3 px-5">
        <span className="text-[15px] font-semibold tabular-nums" data-lightbox-count="">
          {index + 1} of {total}
        </span>
        {current.section && (
          <span className="min-w-0 truncate text-[14px] text-muted-foreground" data-lightbox-section="">
            in “{current.section}”
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="h-9 rounded-md border border-border bg-card px-3 text-[13.5px] hover:bg-muted"
          onClick={() => setFit((f) => (f === 'fit' ? 'actual' : 'fit'))}
          aria-pressed={fit === 'actual'}
          data-lightbox-fit=""
        >
          {fit === 'fit' ? 'Actual size' : 'Fit'}
        </button>
        <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-muted" onClick={onClose} aria-label="Close" data-lightbox-close="">
          <svg {...ICON}>
            <path d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center gap-3 px-4">
        <button type="button" className={circle} onClick={() => step(-1)} aria-label="Previous image" aria-disabled={first || undefined} data-lightbox-prev="">
          <svg {...ICON}>
            <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
          </svg>
        </button>
        <div className={`flex min-h-0 min-w-0 flex-1 self-stretch ${fit === 'fit' ? 'items-center justify-center' : 'overflow-auto'}`} data-lightbox-stage={fit}>
          <img
            key={current.src}
            src={current.src}
            alt={current.alt}
            draggable={false}
            className={fit === 'fit' ? 'max-h-full max-w-full rounded-md object-contain shadow-xl' : 'max-w-none rounded-md'}
            data-lightbox-image=""
          />
        </div>
        <button type="button" className={circle} onClick={() => step(1)} aria-label="Next image" aria-disabled={last || undefined} data-lightbox-next="">
          <svg {...ICON}>
            <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>
      <div className="flex flex-none flex-col items-center gap-2 px-4 pb-4 pt-3">
        {current.alt && <div className="max-w-[90vw] truncate text-[14px] font-medium">{current.alt}</div>}
        <div className="relative flex items-center gap-3">
          <span className="inline-flex items-center gap-px rounded-lg border border-border/70 bg-muted/40 p-0.5">
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" onClick={() => step(-1)} aria-label="Previous image" tabIndex={-1}>
              <svg {...ICON} width={14} height={14}>
                <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
              </svg>
            </button>
            <button
              ref={pillRef}
              type="button"
              className="flex h-7 max-w-[60vw] items-center gap-1.5 rounded-md px-2 text-[13.5px] hover:bg-muted"
              aria-haspopup="grid"
              aria-expanded={peekOpen}
              aria-label={`${index + 1} of ${total}, ${name}. Show every image in this document`}
              onClick={() => setPeekOpen((v) => !v)}
              data-peek-opener=""
              data-lightbox-pill=""
            >
              <span className="tabular-nums text-muted-foreground">
                {index + 1} of {total}
              </span>
              <span className="text-muted-foreground" aria-hidden="true">
                ·
              </span>
              <span className="truncate font-semibold">{name}</span>
              <svg {...ICON} width={13} height={13} className={peekOpen ? 'rotate-180' : ''}>
                <path d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" onClick={() => step(1)} aria-label="Next image" tabIndex={-1}>
              <svg {...ICON} width={14} height={14}>
                <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          </span>
          <span className={`whitespace-nowrap rounded-md bg-muted px-2 py-1 text-[12px] text-muted-foreground transition-opacity ${endNote ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" data-lightbox-end-note="">
            {endNote}
          </span>
          {peekOpen && (
            <div className="absolute bottom-[calc(100%+8px)] left-1/2 z-10 -translate-x-1/2">
              <ImagePeek
                ref={peekRef}
                rows={rows}
                current={String(index)}
                label="Images in this document"
                onPick={(key) => {
                  setPeekOpen(false);
                  go(Number(key));
                  pillRef.current?.focus({ preventScroll: true });
                }}
                onClose={(reason) => {
                  setPeekOpen(false);
                  if (reason === 'key') pillRef.current?.focus({ preventScroll: true });
                }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="sr-only" aria-live="polite" data-lightbox-live="">
        {announced}
      </div>
    </div>
  );
};
