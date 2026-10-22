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

// Zoom (#2067). happy-dom lays nothing out, so the stage's box and the image's
// own size are given here; tests/e2e/inbox-image-viewer.spec.ts measures the
// real thing in Chromium.
const STAGE = { left: 0, top: 0, width: 1000, height: 600 };

/** Give the stage a box and the image a natural size (2000 × 1000), then load it. Fit is then 50%. */
async function loadImage(host: HTMLElement, width = 2000, height = 1000) {
  const stage = host.querySelector<HTMLElement>('[data-lightbox-stage]')!;
  stage.getBoundingClientRect = () =>
    ({ ...STAGE, right: STAGE.left + STAGE.width, bottom: STAGE.top + STAGE.height, x: STAGE.left, y: STAGE.top, toJSON() {} }) as DOMRect;
  const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  await act(async () => { img.dispatchEvent(new Event('load')); });
  return { stage, img };
}

function view(img: HTMLElement) {
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(img.style.transform);
  if (!m) throw new Error(`no transform: ${img.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/** happy-dom's WheelEvent drops some of its init (the pointer, Shift), so they are set on the event. */
function wheelEvent(deltaY: number, init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 500 });
  Object.defineProperty(event, 'clientY', { value: init.clientY ?? 300 });
  for (const key of ['shiftKey', 'ctrlKey', 'metaKey'] as const) Object.defineProperty(event, key, { value: !!init[key] });
  return event;
}

async function wheel(stage: HTMLElement, deltaY: number, init: WheelEventInit = {}) {
  await act(async () => {
    stage.dispatchEvent(wheelEvent(deltaY, init));
  });
}

async function pointer(stage: HTMLElement, type: string, id: number, x: number, y: number, pointerType = 'mouse') {
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true }));
  });
}

describe.if(hasDom)('ImageLightbox: zoom (#2067)', () => {
  // A screen reader hears "Zoom 50%"; the number is what is drawn.
  const zoomText = (host: HTMLElement) => host.querySelector('[data-lightbox-zoom]')?.textContent?.replace(/^Zoom /, '') ?? null;
  const fitButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-lightbox-fit]')!;

  test('opens at Fit; Ctrl/⌘ + wheel (and a pinch) zooms about the pointer, and the header says how far', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
    expect(zoomText(host)).toBe('50%');
    expect(fitButton(host).textContent).toBe('Actual size');
    // The pixel under the pointer (500, 300) stays under it.
    const before = view(img);
    const imageX = (500 - before.x) / before.scale;
    await wheel(stage, -100, { ctrlKey: true });
    const after = view(img);
    expect(after.scale).toBeGreaterThan(0.6);
    expect(after.x + imageX * after.scale).toBeCloseTo(500, 5);
    expect(stage.getAttribute('data-lightbox-stage')).toBe('zoom');
    expect(zoomText(host)).toBe(`${Math.round(after.scale * 100)}%`);
    expect(fitButton(host).textContent).toBe('Fit');
    // ⌘ + wheel zooms too, and the event never reaches the browser's page zoom.
    const event = wheelEvent(-100, { metaKey: true });
    await act(async () => { stage.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(view(img).scale).toBeGreaterThan(after.scale);
  });

  test('zoom stops at Fit and at 800%', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    for (let i = 0; i < 10; i += 1) await wheel(stage, 100, { ctrlKey: true });
    expect(view(img).scale).toBe(0.5);
    expect(stage.getAttribute('data-lightbox-stage')).toBe('fit');
    for (let i = 0; i < 40; i += 1) await wheel(stage, -100, { ctrlKey: true });
    expect(view(img).scale).toBe(8);
    expect(zoomText(host)).toBe('800%');
  });

  test('a plain wheel zooms an image that fits, and scrolls one larger than the stage', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    await wheel(stage, -100);
    expect(view(img).scale).toBeGreaterThan(0.5);

    const other = await mountStepping(IMAGES[1]!.src, () => {});
    const loaded = await loadImage(other);
    await act(async () => fitButton(other).click());
    expect(view(loaded.img)).toEqual({ x: 0, y: 0, scale: 1 });
    await wheel(loaded.stage, 100);
    expect(view(loaded.img)).toEqual({ x: 0, y: -100, scale: 1 });
    // Shift turns it sideways; the image never leaves the stage.
    await wheel(loaded.stage, 5000, { shiftKey: true });
    expect(view(loaded.img)).toEqual({ x: -1000, y: -100, scale: 1 });
    // With Ctrl it zooms even there.
    await wheel(loaded.stage, -100, { ctrlKey: true });
    expect(view(loaded.img).scale).toBeGreaterThan(1);
  });

  test('Fit and Actual size reset the zoom; drag pans; stepping to another image starts at Fit', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    await act(async () => fitButton(host).click());
    // Actual size: its own pixels, read from the top-left where it is larger than the stage.
    expect(view(img)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(stage.getAttribute('data-lightbox-stage')).toBe('actual');
    await pointer(stage, 'pointerdown', 1, 500, 300);
    await pointer(stage, 'pointermove', 1, 400, 250);
    await pointer(stage, 'pointerup', 1, 400, 250);
    expect(view(img)).toEqual({ x: -100, y: -50, scale: 1 });
    await act(async () => fitButton(host).click());
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
    await wheel(stage, -100, { ctrlKey: true });
    expect(view(img).scale).toBeGreaterThan(0.5);
    await act(async () => { press('ArrowRight'); });
    const next = await loadImage(host);
    expect(next.img).not.toBe(img);
    expect(view(next.img).scale).toBe(0.5);
    expect(next.stage.getAttribute('data-lightbox-stage')).toBe('fit');
    expect(fitButton(host).textContent).toBe('Actual size');
  });

  test('a double click toggles Fit and twice Fit at the point; two fingers pinch', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    for (let i = 0; i < 2; i += 1) {
      await pointer(stage, 'pointerdown', 1, 500, 300);
      await pointer(stage, 'pointerup', 1, 500, 300);
    }
    expect(view(img).scale).toBe(1);
    for (let i = 0; i < 2; i += 1) {
      await pointer(stage, 'pointerdown', 1, 500, 300);
      await pointer(stage, 'pointerup', 1, 500, 300);
    }
    expect(view(img).scale).toBe(0.5);
    // Two fingers 200 px apart spread to 400 px: twice the scale.
    await pointer(stage, 'pointerdown', 1, 400, 300, 'touch');
    await pointer(stage, 'pointerdown', 2, 600, 300, 'touch');
    await pointer(stage, 'pointermove', 1, 300, 300, 'touch');
    await pointer(stage, 'pointermove', 2, 700, 300, 'touch');
    await pointer(stage, 'pointerup', 1, 300, 300, 'touch');
    await pointer(stage, 'pointerup', 2, 700, 300, 'touch');
    expect(view(img).scale).toBeCloseTo(1, 5);
  });

  test('the single image overlay zooms too; a tap beside the image closes it from the click after it, on the image it does not', async () => {
    let closed = 0;
    const host = await mount(() => { closed += 1; });
    const { stage, img } = await loadImage(host, 400, 300);
    // Fit never enlarges a small image.
    expect(view(img).scale).toBe(1);
    await pointer(stage, 'pointerdown', 1, 500, 300);
    await pointer(stage, 'pointerup', 1, 500, 300);
    await act(async () => { img.click(); });
    expect(closed).toBe(0);
    await wheel(stage, -100, { ctrlKey: true });
    expect(view(img).scale).toBeGreaterThan(1);
    // The pointerup alone does not close: the overlay must still be there for
    // the click a touch synthesizes, or that click lands on the page beneath.
    await pointer(stage, 'pointerdown', 2, 5, 5);
    await pointer(stage, 'pointerup', 2, 5, 5);
    expect(closed).toBe(0);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { stage.dispatchEvent(click); });
    expect(closed).toBe(1);
    expect(click.defaultPrevented).toBe(true);
  });

  test('a drag that starts beside the image, a cancelled press, or a click with no tap before it never closes', async () => {
    let closed = 0;
    const host = await mount(() => { closed += 1; });
    const { stage } = await loadImage(host, 400, 300);
    await pointer(stage, 'pointerdown', 1, 5, 5);
    await pointer(stage, 'pointermove', 1, 60, 40);
    await pointer(stage, 'pointerup', 1, 60, 40);
    await act(async () => { stage.click(); });
    await pointer(stage, 'pointerdown', 2, 5, 5, 'touch');
    await pointer(stage, 'pointercancel', 2, 5, 5, 'touch');
    await act(async () => { stage.click(); });
    expect(closed).toBe(0);
  });

  test('the focused stage scrolls with the browser\'s scroll keys; ← → still step; nothing reaches the page', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host, 2000, 4000);
    expect(stage.tabIndex).toBe(0);
    expect(stage.getAttribute('aria-label')).toBe('Image: a.png');
    await act(async () => fitButton(host).click());
    // Focus on the overlay (not the stage): ↓ does not pan.
    host.querySelector<HTMLElement>('[data-image-lightbox]')!.focus();
    await act(async () => { press('ArrowDown'); });
    expect(view(img)).toEqual({ x: 0, y: 0, scale: 1 });
    stage.focus();
    const seen = behindTheLightbox();
    let down!: KeyboardEvent;
    await act(async () => { down = press('ArrowDown'); });
    expect(down.defaultPrevented).toBe(true);
    expect(view(img)).toEqual({ x: 0, y: -40, scale: 1 });
    await act(async () => { press('PageDown'); });
    expect(view(img).y).toBe(-40 - 600 * 0.875);
    await act(async () => { press(' ', { shiftKey: true }); });
    expect(view(img).y).toBe(-40);
    await act(async () => { press('End'); });
    expect(view(img).y).toBe(-3400);
    await act(async () => { press('Home'); });
    expect(view(img).y).toBe(0);
    await act(async () => { press(' '); });
    expect(view(img).y).toBe(-525);
    expect(seen).toEqual([]);
    // ← → are still stepping, and focus stays on the new image's stage.
    await act(async () => { press('ArrowRight'); });
    expect(host.querySelector('[data-lightbox-count]')!.textContent).toBe('2 of 3');
    const next = host.querySelector<HTMLElement>('[data-lightbox-stage]')!;
    expect(next).not.toBe(stage);
    expect(document.activeElement).toBe(next);
    await act(async () => { press(']'); });
    expect(host.querySelector('[data-lightbox-count]')!.textContent).toBe('3 of 3');
    expect(document.activeElement).toBe(host.querySelector('[data-lightbox-stage]'));
  });

  test('the single overlay\'s focused stage takes ← → as sideways scrolling', async () => {
    const host = await mount(() => {});
    const { stage, img } = await loadImage(host, 3000, 300);
    await wheel(stage, -100, { ctrlKey: true });
    const before = view(img);
    stage.focus();
    await act(async () => { press('ArrowRight'); });
    expect(view(img).x).toBeCloseTo(before.x - 40, 5);
  });

  test('Safari\'s gesture events (a trackpad pinch) zoom the image and never the page', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    const { stage, img } = await loadImage(host);
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { scale, clientX: 500, clientY: 300 });
      return event;
    };
    const start = gesture('gesturestart', 1);
    await act(async () => { stage.dispatchEvent(start); });
    const change = gesture('gesturechange', 2);
    await act(async () => { stage.dispatchEvent(change); });
    await act(async () => { stage.dispatchEvent(gesture('gestureend', 2)); });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(view(img).scale).toBeCloseTo(1, 5);
    // Over the header, too, the page does not zoom.
    const header = host.querySelector('[data-lightbox-count]')!;
    const overHeader = gesture('gesturechange', 3);
    await act(async () => { header.dispatchEvent(overHeader); });
    expect(overHeader.defaultPrevented).toBe(true);
    expect(view(img).scale).toBeCloseTo(1, 5);
  });

  test('Ctrl + wheel over the header or the buttons never zooms the page; a plain wheel there is left alone', async () => {
    const host = await mountStepping(IMAGES[0]!.src, () => {});
    await loadImage(host);
    const next = host.querySelector('[data-lightbox-next]')!;
    const ctrl = wheelEvent(-100, { ctrlKey: true });
    await act(async () => { next.dispatchEvent(ctrl); });
    expect(ctrl.defaultPrevented).toBe(true);
    const plain = wheelEvent(-100);
    await act(async () => { next.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
  });

  test('stepping to an image with the same src still starts at Fit and shows its scale', async () => {
    const same = [IMAGES[0]!, { ...IMAGES[0]!, section: 'Again' }];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const { ImageLightbox } = lightboxModule!;
    await act(async () => { root.render(<ImageLightbox src={same[0]!.src} alt="" images={same} onClose={() => {}} />); });
    cleanups.push(() => root.unmount());
    const first = await loadImage(host);
    await wheel(first.stage, -100, { ctrlKey: true });
    await act(async () => { press('ArrowRight'); });
    expect(host.querySelector('[data-lightbox-count]')!.textContent).toBe('2 of 2');
    expect(zoomText(host)).toBeNull();
    const second = await loadImage(host);
    expect(view(second.img).scale).toBe(0.5);
    expect(zoomText(host)).toBe('50%');
  });
});
