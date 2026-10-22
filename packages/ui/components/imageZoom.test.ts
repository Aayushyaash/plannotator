/**
 * The zoom math's host seams (the Inbox's file viewer): Fit by width or
 * height, the padding Fit leaves, and the Fit scale a gesture compares with.
 * The lightbox's own cases are in ImageLightbox.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import { atFit, fitScale, fitViewport, paddingInset, zoomLimits } from './imageZoom';

const stage = { width: 1000, height: 600 };

describe('imageZoom: fit axis and padding', () => {
  test('a tall screenshot fits its width and starts at its top; the smallest scale is still the whole image', () => {
    const tall = { width: 2000, height: 6000 };
    expect(fitScale(tall, stage, undefined, 'width')).toBe(0.5);
    expect(fitViewport(tall, stage, undefined, 'width')).toEqual({ x: 0, y: 0, scale: 0.5 });
    expect(zoomLimits(tall, stage).min).toBe(0.1);
  });

  test('a panorama fits its height and starts at its left edge', () => {
    const wide = { width: 6000, height: 1200 };
    expect(fitViewport(wide, stage, undefined, 'height')).toEqual({ x: 0, y: 0, scale: 0.5 });
    // Never above its own size.
    expect(fitScale({ width: 600, height: 100 }, stage, undefined, 'height')).toBe(1);
  });

  test('contain is the default and unchanged', () => {
    expect(fitViewport({ width: 2000, height: 1000 }, stage)).toEqual({ x: 0, y: 50, scale: 0.5 });
  });

  test('padding leaves that many pixels on every side, never below a tenth', () => {
    expect(paddingInset(stage, 50)).toEqual({ x: 0.9, y: 500 / 600 });
    expect(paddingInset({ width: 40, height: 40 }, 30)).toEqual({ x: 0.1, y: 0.1 });
    expect(paddingInset(stage, 0)).toEqual({ x: 1, y: 1 });
    const view = fitViewport({ width: 2000, height: 1000 }, stage, paddingInset(stage, 50));
    expect(view.scale).toBe(0.45);
    expect(view.x).toBe(50);
  });

  test('atFit takes the limits or a Fit scale', () => {
    expect(atFit({ x: 0, y: 0, scale: 0.5 }, { min: 0.5, max: 8 })).toBe(true);
    expect(atFit({ x: 0, y: 0, scale: 0.5 }, 0.25)).toBe(false);
    expect(atFit({ x: 0, y: 0, scale: 0.25 }, 0.25)).toBe(true);
  });
});
