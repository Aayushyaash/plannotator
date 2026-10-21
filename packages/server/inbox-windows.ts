/**
 * Which Inbox windows are open, and whether any of them can show a
 * notification.
 *
 * Browser notifications come from an open Inbox tab: with no tab open, or
 * only tabs the browser does not let notify, nothing reaches the person. The
 * server cannot see a browser's permission, so each window reports it: its
 * event stream carries `window=<id>` (plus the permission and origin it had
 * when it connected), and `POST /api/inbox/window` reports a change. A window
 * counts as open while it holds an event stream; a record outlives its last
 * stream by `WINDOW_GRACE_MS`, so an EventSource reconnect (or a report that
 * lands before the stream) keeps what the page said.
 *
 * Everything is in memory: a restart forgets the windows, and they report
 * again as their streams reconnect.
 */

import type { InboxNotifyReach, InboxWindowPermission } from "@plannotator/core/inbox-types";

/** How long a window's record outlives its last event stream (an EventSource reconnects in ~2 s). */
export const WINDOW_GRACE_MS = 15_000;

const WINDOW_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PERMISSIONS: readonly InboxWindowPermission[] = ["granted", "default", "denied", "unsupported"];

/** A window id the page made (`crypto.randomUUID()` or similar), or null. */
export function parseWindowId(value: unknown): string | null {
  return typeof value === "string" && WINDOW_ID.test(value) ? value : null;
}

/** A permission the page reported, or null. */
export function parseWindowPermission(value: unknown): InboxWindowPermission | null {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value) ? (value as InboxWindowPermission) : null;
}

/** An `http(s)://host[:port]` origin the page reported, or null. */
export function parseWindowOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

interface WindowRecord {
  streams: number;
  permission: InboxWindowPermission;
  origin: string | null;
  via: "local" | "tailnet";
  drop: ReturnType<typeof setTimeout> | null;
}

export interface InboxWindows {
  /** An event stream opened for `id`; call the answer when it closes. */
  connect(id: string, report: { permission: InboxWindowPermission | null; origin: string | null; via: "local" | "tailnet" }): () => void;
  /** The page's report: its permission (and origin) changed. */
  report(id: string, report: { permission: InboxWindowPermission; origin: string | null; via: "local" | "tailnet" }): void;
  /** What Settings shows: open windows and how many can notify. */
  reach(enabled: boolean): InboxNotifyReach;
  /** Called when `reach` may have changed. */
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export function createInboxWindows(options: { graceMs?: number } = {}): InboxWindows {
  const graceMs = options.graceMs ?? WINDOW_GRACE_MS;
  const windows = new Map<string, WindowRecord>();
  const listeners = new Set<() => void>();
  let last = "";
  const changed = () => {
    // Tell the pages only when the counts they draw changed.
    const key = JSON.stringify(summary());
    if (key === last) return;
    last = key;
    for (const listener of listeners) listener();
  };
  const summary = () => {
    const open = [...windows.values()].filter((w) => w.streams > 0);
    const allowed = open.filter((w) => w.permission === "granted");
    return {
      windows: open.length,
      allowed: allowed.length,
      allowed_origins: [...new Set(allowed.map((w) => w.origin).filter((o): o is string => o !== null))].sort(),
    };
  };
  const scheduleDrop = (id: string, record: WindowRecord) => {
    if (record.drop) clearTimeout(record.drop);
    record.drop = setTimeout(() => {
      if (windows.get(id) === record && record.streams === 0) {
        windows.delete(id);
        changed();
      }
    }, graceMs);
    (record.drop as { unref?: () => void }).unref?.();
  };
  const recordOf = (id: string, via: "local" | "tailnet"): WindowRecord => {
    let record = windows.get(id);
    if (!record) {
      record = { streams: 0, permission: "unknown", origin: null, via, drop: null };
      windows.set(id, record);
    }
    return record;
  };

  return {
    connect(id, report) {
      const record = recordOf(id, report.via);
      // A reconnect's URL carries what the page said when it first connected:
      // a report made since (POST) wins over it.
      if (record.permission === "unknown" && report.permission) record.permission = report.permission;
      if (record.origin === null && report.origin) record.origin = report.origin;
      record.via = report.via;
      record.streams += 1;
      if (record.drop) {
        clearTimeout(record.drop);
        record.drop = null;
      }
      changed();
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        record.streams = Math.max(0, record.streams - 1);
        if (record.streams === 0) scheduleDrop(id, record);
        changed();
      };
    },
    report(id, report) {
      const record = recordOf(id, report.via);
      record.permission = report.permission;
      if (report.origin) record.origin = report.origin;
      record.via = report.via;
      // A report before the stream (or after it closed) is kept for the grace only.
      if (record.streams === 0) scheduleDrop(id, record);
      changed();
    },
    reach(enabled) {
      return { enabled, ...summary() };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      for (const record of windows.values()) if (record.drop) clearTimeout(record.drop);
      windows.clear();
      listeners.clear();
    },
  };
}
