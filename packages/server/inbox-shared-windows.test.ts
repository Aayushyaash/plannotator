/**
 * Tabs share one event stream (packages/inbox/sharedEvents.ts), the server's
 * half: a follower tab holds no stream, so it reports `served_by` (the leader
 * tab's window id) and counts for `notify_reach` while that leader is known;
 * a tab that closes reports `gone` and stops counting at once; health counts
 * the event streams open (`event_streams`), which the browser proofs read to
 * show one stream per origin.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxNotifyReach } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer, type InboxServerOptions } from "./inbox";
import { createInboxWindows } from "./inbox-windows";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inbox(options: Partial<InboxServerOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-shared-windows-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data"), htmlContent: "<!doctype html><title>Inbox</title>", ...options });
  servers.push(server);
  return server;
}

async function healthOf(server: InboxServer): Promise<{ notify_reach: InboxNotifyReach; event_streams: number }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json()) as { notify_reach: InboxNotifyReach; event_streams: number };
}

const report = (server: InboxServer, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function openStream(server: InboxServer, id: string, permission = "granted"): AbortController {
  const controller = new AbortController();
  void fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0&window=${id}&permission=${permission}&origin=${encodeURIComponent("http://localhost:1")}`, {
    signal: controller.signal,
  })
    .then((res) => res.body?.getReader().read())
    .catch(() => {});
  return controller;
}

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("createInboxWindows: a follower counts while its leader is known, through a handover, and leaves at once when gone", async () => {
  const windows = createInboxWindows({ graceMs: 80 });
  const leave = windows.connect("w-leader-0001", { permission: "granted", origin: "http://localhost:1", via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0001" });
  windows.report("w-follow-0002", { permission: "default", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0001" });
  expect(windows.reach(true)).toEqual({ enabled: true, windows: 3, allowed: 2, allowed_origins: ["http://localhost:1"] });

  // Followers stay counted far past the grace while their leader holds its stream.
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 3, allowed: 2 });

  // A follower without a known leader is not counted (a report alone is not a window).
  windows.report("w-lonely-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-nobody-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });

  // A follower that closes stops counting at once.
  windows.leave("w-follow-0002");
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  // The leader closes: it stops counting at once, its follower stays through the grace (the handover)…
  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 1, allowed: 1 });
  // …and moves to the new leader before the grace ends.
  const leave2 = windows.connect("w-leader-0002", { permission: "granted", origin: "http://localhost:1", via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0002" });
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  // The whole browser goes: the last stream closes, and its followers go with the leader's grace.
  leave2();
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  await Bun.sleep(300);
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });

  // A report after `gone` (a page back from the back/forward cache) counts it again.
  const leave3 = windows.connect("w-leader-0003", { permission: "granted", origin: null, via: "local" });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  windows.leave("w-follow-0003");
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
  // A tab cannot be served by itself.
  windows.report("w-leader-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
  leave3();
  windows.stop();
});

test("createInboxWindows: a leader that says gone before its stream closes stops counting; its followers keep counting through the grace", async () => {
  const windows = createInboxWindows({ graceMs: 80 });
  const leave = windows.connect("w-leader-0001", { permission: "granted", origin: null, via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0001" });
  windows.leave("w-leader-0001");
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  await Bun.sleep(300);
  expect(windows.reach(true)).toMatchObject({ windows: 0 });
  windows.stop();
});

test("POST /api/inbox/window: served_by and gone are additive; health counts the event streams open", async () => {
  const server = await inbox({ windowGraceMs: 100 });
  expect((await healthOf(server)).event_streams).toBe(0);

  const leader = openStream(server, "w-leader-0001");
  await until(async () => (await healthOf(server)).event_streams === 1);
  // A stream without a window (the phone's door) counts too.
  const door = new AbortController();
  void fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0`, { signal: door.signal })
    .then((r) => r.body?.getReader().read())
    .catch(() => {});
  await until(async () => (await healthOf(server)).event_streams === 2);
  door.abort();
  await until(async () => (await healthOf(server)).event_streams === 1);

  const follower = await report(server, { window: "w-follow-0001", permission: "granted", origin: "http://localhost:1", served_by: "w-leader-0001" });
  expect(follower.status).toBe(200);
  expect(((await follower.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 2, allowed: 2 });
  await Bun.sleep(250);
  expect((await healthOf(server)).notify_reach).toMatchObject({ windows: 2 });

  // `gone` needs only the window (a beacon at pagehide), and is validated like a report.
  const gone = await report(server, { window: "w-follow-0001", gone: true });
  expect(gone.status).toBe(200);
  expect(((await gone.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 1 });
  expect((await report(server, { window: "bad id!", gone: true })).status).toBe(422);
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: "bad id!" })).status).toBe(422);
  // `served_by: null` is a tab with its own stream (no leader).
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: null })).status).toBe(200);

  // A beacon is a Blob with a JSON type, from the page's own origin: accepted.
  const beacon = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" },
    body: new Blob([JSON.stringify({ window: "w-leader-0001", gone: true })], { type: "application/json" }),
  });
  expect(beacon.status).toBe(200);
  expect((await healthOf(server)).notify_reach).toMatchObject({ windows: 0 });
  // Another site cannot say a tab is gone.
  const cross = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ window: "w-leader-0001", gone: true }),
  });
  expect(cross.status).toBe(403);

  leader.abort();
  await until(async () => (await healthOf(server)).event_streams === 0);
});
