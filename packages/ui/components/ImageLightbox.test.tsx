/**
 * The image lightbox is keyboard-modal. The failures this guards: Escape
 * reaching the raw-HTML surface's Esc ladder (which would also drop the page
 * to Interact) instead of only closing the lightbox, and Mod+Enter submitting
 * a review decision behind an open lightbox. Both app-level handlers listen on
 * the window in the bubble phase, which is what the probe listener stands in
 * for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const lightboxModule = hasDom ? await import('./ImageLightbox') : null;

const cleanups: Array<() => void> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  document.body.replaceChildren();
});

async function mount(onClose: () => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const { ImageLightbox } = lightboxModule!;
  await act(async () => {
    root.render(<ImageLightbox src="/api/html-assets/t/x.png" alt="x.png" onClose={onClose} />);
  });
  cleanups.push(() => root.unmount());
  return host;
}

function behindTheLightbox() {
  const seen: string[] = [];
  const listener = (e: KeyboardEvent) => seen.push(e.key);
  window.addEventListener('keydown', listener);
  cleanups.push(() => window.removeEventListener('keydown', listener));
  return seen;
}

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe.if(hasDom)('ImageLightbox', () => {
  test('Escape closes it and never reaches the page behind', async () => {
    let closed = 0;
    await mount(() => { closed += 1; });
    const seen = behindTheLightbox();
    await act(async () => { press('Escape'); });
    expect(closed).toBe(1);
    expect(seen).toEqual([]);
  });

  test('Mod+Enter is swallowed so no decision submits behind it', async () => {
    await mount(() => {});
    const seen = behindTheLightbox();
    const meta = press('Enter', { metaKey: true });
    const ctrl = press('Enter', { ctrlKey: true });
    expect(seen).toEqual([]);
    expect(meta.defaultPrevented).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
  });

  test('takes focus when it opens, so keys typed after an iframe click reach it', async () => {
    const host = await mount(() => {});
    expect(document.activeElement === host.querySelector('[data-image-lightbox]')).toBe(true);
  });

  test('once closed, keys reach the page again', async () => {
    await mount(() => {});
    await act(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); });
    const seen = behindTheLightbox();
    press('Escape');
    expect(seen).toEqual(['Escape']);
  });
});

const IMAGES = [
  { src: '/api/image?path=%2Fdocs%2Fa.png', alt: 'A', section: 'Options' },
  { src: '/api/image?path=%2Fdocs%2Fb.png', alt: 'B', section: 'Options' },
  { src: '/api/image?path=%2Fdocs%2Fm.png', alt: 'M', section: 'Mobile' },
];

async function mountStepping(src: string, onClose: () => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const { ImageLightbox } = lightboxModule!;
  await act(async () => {
    root.render(<ImageLightbox src={src} alt="" images={IMAGES} onClose={onClose} />);
  });
  cleanups.push(() => root.unmount());
  return host;
}

describe.if(hasDom)('ImageLightbox: the light version (plan review and annotate)', () => {
  const count = (host: HTMLElement) => host.querySelector('[data-lightbox-count]')!.textContent;

  test('opens on the clicked image with its section; ← → step and stop at the ends with a note; keys never reach the page', async () => {
    const host = await mountStepping(IMAGES[1]!.src, () => {});
    const seen = behindTheLightbox();
    expect(count(host)).toBe('2 of 3');
    expect(host.querySelector('[data-lightbox-section]')!.textContent).toBe('in “Options”');
    expect(host.querySelector('[data-lightbox-pill]')!.textContent).toContain('b.png');
    await act(async () => { press('ArrowRight'); });
    expect(count(host)).toBe('3 of 3');
    expect(host.querySelector('[data-lightbox-section]')!.textContent).toBe('in “Mobile”');
    await act(async () => { press('ArrowRight'); });
    expect(count(host)).toBe('3 of 3');
    expect(host.querySelector('[data-lightbox-end-note]')!.textContent).toBe('Last image in this document');
    await act(async () => { press('['); });
    expect(count(host)).toBe('2 of 3');
    expect(seen).toEqual([]);
    // No pen and no comment box.
    expect(host.querySelector('textarea')).toBeNull();
  });

  test('the pill opens the peek (rows by section); its keys move and Enter opens; Esc closes the peek, then the viewer', async () => {
    let closed = 0;
    const host = await mountStepping(IMAGES[0]!.src, () => { closed += 1; });
    const pill = host.querySelector<HTMLButtonElement>('[data-lightbox-pill]')!;
    await act(async () => pill.click());
    const grid = host.querySelector('[role="grid"]')!;
    expect(grid.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(grid.querySelector('[aria-selected="true"]')!.getAttribute('data-peek-item')).toBe('0');
    await act(async () => { press('ArrowDown'); });
    expect(count(host)).toBe('1 of 3');
    await act(async () => { press('Enter'); });
    expect(host.querySelector('[role="grid"]')).toBeNull();
    expect(count(host)).toBe('3 of 3');
    expect(document.activeElement).toBe(pill);
    await act(async () => pill.click());
    await act(async () => { press('Escape'); });
    expect(host.querySelector('[role="grid"]')).toBeNull();
    expect(closed).toBe(0);
    await act(async () => { press('Escape'); });
    expect(closed).toBe(1);
  });

  test('collectDocumentImages reads the zoomable images in order under their headings', () => {
    const article = document.createElement('article');
    article.innerHTML = '<h2>Options</h2><img class="cursor-zoom-in" src="a.png" alt="A"><img src="icon.svg"><h2>Mobile</h2><p><img class="cursor-zoom-in" src="m.png" alt="M"></p><img class="cursor-zoom-in" src="a.png">';
    expect(lightboxModule!.collectDocumentImages(article)).toEqual([
      { src: 'a.png', alt: 'A', section: 'Options' },
      { src: 'm.png', alt: 'M', section: 'Mobile' },
    ]);
  });
});
