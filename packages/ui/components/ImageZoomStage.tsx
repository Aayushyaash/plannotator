import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  actualViewport,
  atFit,
  clampViewport,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_ZOOM,
  fitViewport,
  overflows,
  panBy,
  TAP_SLOP_MOUSE_PX,
  TAP_SLOP_TOUCH_PX,
  WHEEL_LATCH_MS,
  wheelTravel,
  wheelZoomFactor,
  zoomAt,
  zoomLimits,
  type ZoomInset,
  type ZoomSize,
  type ZoomViewport,
} from './imageZoom';

/** Fit (the whole image), Actual size (its own pixels), or anything a gesture left. */
export type ZoomMode = 'fit' | 'actual' | 'zoom';

interface StageBox extends ZoomSize {
  left: number;
  top: number;
}

interface Press {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  slop: number;
  moved: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The lightbox's image, zoomable (#2067). The image is drawn at its own size
 * and moved with a transform only (translate + scale), so a gesture never
 * lays anything out.
 *
 * - Ctrl/⌘ + wheel, and a trackpad pinch (which the browser sends as a wheel
 *   with ctrlKey), zoom about the pointer.
 * - A plain wheel scrolls the image when it is larger than the stage (as a
 *   page scrolls, Shift or a sideways swipe for the other axis), and zooms
 *   about the pointer when the whole image is on screen, where there is
 *   nothing to scroll. One wheel gesture keeps the meaning it started with.
 * - Mouse or one-finger drag pans when there is something to pan; two
 *   fingers pinch-zoom about their midpoint and pan with it.
 * - Double click (or double tap) on the image zooms to twice the Fit scale
 *   about that point, and back to Fit.
 * - Limits: Fit (never above 1) to 800%.
 *
 * `mode` is the host's (its Fit / Actual size control); a gesture reports
 * `zoom` (or `fit` when it lands back on the Fit scale) through
 * `onModeChange`. The host keys the stage by the image, so stepping to
 * another image starts at Fit. Discrete jumps (the control, a double click)
 * ease over 180 ms unless the reader prefers reduced motion; gestures never
 * animate.
 */
export const ImageZoomStage: React.FC<{
  src: string;
  alt: string;
  mode: ZoomMode;
  onModeChange: (mode: ZoomMode) => void;
  /** The current scale (1 = Actual size), on every change. */
  onScaleChange?: (scale: number) => void;
  /** The share of the stage Fit may fill on each axis. */
  inset?: ZoomInset;
  /** A tap (a click that did not pan) beside the image, e.g. to close. */
  onBackgroundTap?: () => void;
  /** The stage's box, its position included (`relative` when absent). */
  className?: string;
  imageClassName?: string;
  /** The image's corner radius at Actual size; kept constant on screen at every scale. */
  radius?: number;
  stageAttributes?: Record<string, string>;
}> = ({ src, alt, mode, onModeChange, onScaleChange, inset, onBackgroundTap, className, imageClassName, radius = 6, stageAttributes }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState<ZoomSize | null>(null);
  const [failed, setFailed] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [panning, setPanning] = useState(false);

  const insetRef = useRef(inset);
  insetRef.current = inset;
  const dimsRef = useRef<ZoomSize | null>(null);
  const boxRef = useRef<StageBox | null>(null);
  const viewRef = useRef<ZoomViewport | null>(null);
  const modeRef = useRef(mode);
  const reportedRef = useRef<ZoomMode>(mode);
  const callbacks = useRef({ onModeChange, onScaleChange, onBackgroundTap });
  callbacks.current = { onModeChange, onScaleChange, onBackgroundTap };
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<Press | null>(null);
  const pinch = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const latch = useRef<{ kind: 'zoom' | 'pan'; until: number } | null>(null);

  const measure = useCallback((): StageBox | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    boxRef.current = { width: r.width, height: r.height, left: r.left, top: r.top };
    return boxRef.current;
  }, []);

  const limits = () => zoomLimits(dimsRef.current!, boxRef.current!, insetRef.current);
  const ready = () => !!dimsRef.current && !!boxRef.current && boxRef.current.width > 0 && boxRef.current.height > 0;

  const apply = useCallback(
    (view: ZoomViewport, animate = false) => {
      viewRef.current = view;
      const img = imgRef.current;
      if (img) {
        img.style.transition = animate && !prefersReducedMotion() ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' : 'none';
        img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
        img.style.borderRadius = `${radius / view.scale}px`;
      }
      if (dimsRef.current && boxRef.current) setOverflowing(overflows(view, dimsRef.current, boxRef.current));
      callbacks.current.onScaleChange?.(view.scale);
    },
    [radius],
  );

  /** A gesture moved the image: report Fit when it is back at the Fit scale, else zoom. */
  const gesture = (view: ZoomViewport) => {
    apply(view);
    const next: ZoomMode = atFit(view, limits()) ? 'fit' : 'zoom';
    if (next !== reportedRef.current) {
      reportedRef.current = next;
      modeRef.current = next;
      callbacks.current.onModeChange(next);
    }
  };

  const applyMode = useCallback(
    (next: ZoomMode, animate: boolean) => {
      if (!ready()) return;
      const image = dimsRef.current!;
      const box = boxRef.current!;
      if (next === 'fit') apply(fitViewport(image, box, insetRef.current), animate);
      else if (next === 'actual') apply(actualViewport(image, box, insetRef.current), animate);
      else if (viewRef.current) apply(clampViewport(viewRef.current, image, box, limits()), animate);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apply],
  );

  // The host's control: Fit or Actual size (a mode we reported ourselves is already on screen).
  useLayoutEffect(() => {
    modeRef.current = mode;
    if (mode === reportedRef.current) return;
    reportedRef.current = mode;
    applyMode(mode, true);
  }, [mode, applyMode]);

  // The image's own size, once it has loaded (or at once when it was cached).
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setDims({ width: img.naturalWidth, height: img.naturalHeight });
  }, []);

  useLayoutEffect(() => {
    dimsRef.current = dims;
    if (!dims) return;
    measure();
    applyMode(modeRef.current === 'zoom' ? 'fit' : modeRef.current, false);
  }, [dims, measure, applyMode]);

  // The stage resized (the window, a phone turned): Fit refits, anything else keeps its scale within the new limits.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      measure();
      if (!ready()) return;
      if (modeRef.current === 'fit' || !viewRef.current) applyMode('fit', false);
      else apply(clampViewport(viewRef.current, dimsRef.current!, boxRef.current!, limits()));
    });
    observer.observe(stage);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, applyMode, apply]);

  // Wheel and trackpad pinch. A non-passive listener, so preventDefault keeps
  // the browser from zooming the page (Ctrl+wheel, pinch) or swiping back.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const latched = latch.current && now < latch.current.until ? latch.current : null;
      // One layout read at the start of a gesture, never between writes.
      if (!latched || !boxRef.current) measure();
      if (!ready() || !viewRef.current) return;
      const image = dimsRef.current!;
      const box = boxRef.current!;
      const { dx, dy } = wheelTravel(event, box.height);
      const px = Number.isFinite(event.clientX) ? event.clientX - box.left : box.width / 2;
      const py = Number.isFinite(event.clientY) ? event.clientY - box.top : box.height / 2;
      if (event.ctrlKey || event.metaKey) {
        latch.current = null;
        if (Math.abs(dy) < 0.1) return;
        gesture(zoomAt(viewRef.current, wheelZoomFactor(dy), px, py, image, box, limits()));
        return;
      }
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;
      const kind = latched ? latched.kind : overflows(viewRef.current, image, box) ? 'pan' : 'zoom';
      latch.current = { kind, until: now + WHEEL_LATCH_MS };
      if (kind === 'pan') {
        gesture(panBy(viewRef.current, -dx, -dy, image, box, limits()));
      } else if (Math.abs(dy) > Math.abs(dx)) {
        // A sideways swipe over a fitted image is not a zoom.
        gesture(zoomAt(viewRef.current, wheelZoomFactor(dy), px, py, image, box, limits()));
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure]);

  const toggleZoomAt = (px: number, py: number) => {
    if (!ready() || !viewRef.current) return;
    const lim = limits();
    if (!atFit(viewRef.current, lim)) {
      reportedRef.current = 'fit';
      modeRef.current = 'fit';
      apply(fitViewport(dimsRef.current!, boxRef.current!, insetRef.current), true);
      callbacks.current.onModeChange('fit');
      return;
    }
    const target = Math.min(lim.max, lim.min * DOUBLE_TAP_ZOOM);
    const view = zoomAt(viewRef.current, target / viewRef.current.scale, px, py, dimsRef.current!, boxRef.current!, lim);
    reportedRef.current = 'zoom';
    modeRef.current = 'zoom';
    apply(view, true);
    callbacks.current.onModeChange('zoom');
  };

  const tap = (clientX: number, clientY: number) => {
    const box = boxRef.current;
    const view = viewRef.current;
    const image = dimsRef.current;
    if (!box || !view || !image) {
      lastTap.current = null;
      callbacks.current.onBackgroundTap?.();
      return;
    }
    const px = clientX - box.left;
    const py = clientY - box.top;
    const onImage = px >= view.x && px <= view.x + image.width * view.scale && py >= view.y && py <= view.y + image.height * view.scale;
    if (!onImage) {
      lastTap.current = null;
      callbacks.current.onBackgroundTap?.();
      return;
    }
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(clientX - prev.x, clientY - prev.y) <= DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      toggleZoomAt(px, py);
      return;
    }
    lastTap.current = { t: now, x: clientX, y: clientY };
  };

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), midX: (a!.x + b!.x) / 2, midY: (a!.y + b!.y) / 2 };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    measure();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer (tests) has nothing to capture.
      }
    }
    if (pointers.current.size === 2) {
      pinch.current = pinchState();
      if (press.current) press.current.moved = true;
      return;
    }
    if (pointers.current.size > 2) return;
    press.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      slop: event.pointerType === 'touch' ? TAP_SLOP_TOUCH_PX : TAP_SLOP_MOUSE_PX,
      moved: false,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!ready() || !viewRef.current) return;
    const image = dimsRef.current!;
    const box = boxRef.current!;
    if (pinch.current && pointers.current.size >= 2) {
      const next = pinchState();
      const prev = pinch.current;
      let view = zoomAt(viewRef.current, next.dist / prev.dist, next.midX - box.left, next.midY - box.top, image, box, limits());
      view = panBy(view, next.midX - prev.midX, next.midY - prev.midY, image, box, limits());
      pinch.current = next;
      gesture(view);
      return;
    }
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    if (!p.moved) {
      if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < p.slop) return;
      p.moved = true;
      if (overflows(viewRef.current, image, box)) setPanning(true);
    }
    const dx = event.clientX - p.lastX;
    const dy = event.clientY - p.lastY;
    p.lastX = event.clientX;
    p.lastY = event.clientY;
    gesture(panBy(viewRef.current, dx, dy, image, box, limits()));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      // The finger left behind carries on panning from where it is, never as a tap.
      const [rest] = [...pointers.current.entries()];
      if (rest) {
        const [id, at] = rest;
        press.current = { id, startX: at.x, startY: at.y, lastX: at.x, lastY: at.y, slop: 0, moved: true };
      } else {
        press.current = null;
      }
      return;
    }
    const p = press.current;
    if (!p || p.id !== event.pointerId) return;
    press.current = null;
    setPanning(false);
    if (!cancelled && !p.moved) tap(event.clientX, event.clientY);
  };

  const cursor = panning ? 'grabbing' : overflowing ? 'grab' : onBackgroundTap ? 'zoom-out' : 'default';
  return (
    <div
      ref={stageRef}
      className={`touch-none select-none overflow-hidden ${className ?? 'relative'}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      {...stageAttributes}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) setDims({ width: img.naturalWidth, height: img.naturalHeight });
        }}
        onError={() => setFailed(true)}
        className={imageClassName}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          maxWidth: 'none',
          maxHeight: 'none',
          width: dims ? `${dims.width}px` : undefined,
          height: dims ? `${dims.height}px` : undefined,
          transformOrigin: '0 0',
          opacity: dims ? 1 : 0,
          cursor: overflowing ? undefined : 'zoom-in',
        }}
        data-lightbox-image=""
      />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-sm opacity-70" data-lightbox-failed="">
          This image could not be loaded.
        </div>
      )}
    </div>
  );
};
