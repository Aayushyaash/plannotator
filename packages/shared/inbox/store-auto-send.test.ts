/**
 * A reply that waits on a busy agent goes into its running turn by itself
 * after `INBOX_AUTO_SEND_AFTER_MS` (owner approval "inbox-busy-agent-reply",
 * 2026-10-21), exactly as if the person pressed Send now: the store's
 * `autoSendDue` marks `deliver_now_at` with `deliver_now_by: "auto"`. The
 * caller (the server) asks only for a session that works now and whose
 * connection can take an item mid-turn; the store decides what is due from
 * each item's own `created_at`, once. Proved on a real store in a temp dir
 * with an injected clock, a reopen from disk included.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AUTO_SEND_AFTER_MS, inboxDeliveryState, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AFTER = INBOX_AUTO_SEND_AFTER_MS;
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const START = Date.parse("2026-10-21T13:48:00.000Z");

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-auto-send-")), clock = { now: START }) {
  if (!roots.includes(dir)) roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

function setup() {
  const opened = open();
  const project = opened.store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: "CSV or Parquet?", wakes: true }).message;
  return { ...opened, project, asked };
}

describe("autoSendDue", () => {
  test("fires at 5 minutes, not before, once; marked as the Inbox's (deliver_now_by: auto)", () => {
    const { store, clock, asked } = setup();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += AFTER - 1;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
    expect(store.message(reply.id)!.deliver_now_at ?? null).toBeNull();

    clock.now += 1;
    const lines = store.cursor();
    const [marked] = store.autoSendDue("ses_a", { afterMs: AFTER });
    expect(marked).toMatchObject({ id: reply.id, deliver_now_by: "auto", deliver_now_at: new Date(clock.now).toISOString() });
    expect(store.cursor()).toBe(lines + 1);
    // Never twice: a second look writes nothing, even much later.
    clock.now += 60 * 60_000;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
    expect(store.cursor()).toBe(lines + 1);
    // Another session is never handed it, so never marks it.
    expect(store.autoSendDue("ses_b", { afterMs: AFTER })).toEqual([]);
  });

  test("a failed attempt (the connection said send_now_failed) is never retried by itself; the person's Send now still works", () => {
    const { store, clock, asked } = setup();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += AFTER;
    store.autoSendDue("ses_a", { afterMs: AFTER });
    store.clearDeliverNow(reply.id, "ses_a");
    expect(store.message(reply.id)).toMatchObject({ deliver_now_at: null, deliver_now_by: "auto" });
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
    expect(store.requestDeliverNow(reply.id)).toMatchObject({ deliver_now_by: "person" });
  });

  test("a reply the person already sent now is left alone; so is a delivered one", () => {
    const { store, clock, asked } = setup();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    store.requestDeliverNow(reply.id);
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
    expect(store.message(reply.id)!.deliver_now_by).toBe("person");
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a" });
    expect(store.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
  });

  test("survives a restart: measured from the reply's own created_at, read back from disk", () => {
    const { store, dir, clock, asked } = setup();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += 2 * 60_000;
    // The Inbox stops and starts again 4 minutes later: the reply is due at once.
    const later = { now: clock.now + 4 * 60_000 };
    const reopened = open(dir, later).store;
    const [marked] = reopened.autoSendDue("ses_a", { afterMs: AFTER });
    expect(marked!.id).toBe(reply.id);
    // And once marked, a second restart never marks it again.
    const again = open(dir, { now: later.now + AFTER }).store;
    expect(again.message(reply.id)!.deliver_now_by).toBe("auto");
    expect(again.autoSendDue("ses_a", { afterMs: AFTER })).toEqual([]);
  });

  test("the Inbox's set-aside note never goes in by itself; the note carrying a 👍 does", () => {
    const { store, clock, project } = setup();
    const q = store.sendMessage({ project_id: project.id, author: AGENT, body: [":::question", "Which region?", "", "- [ ] us", "- [ ] eu", ":::"].join("\n"), wakes: true }).message;
    store.markRead(q.thread_id, true);
    clock.now += 10_000;
    const notes = store.tellSetAside(q.thread_id, 10_000);
    expect(notes.length).toBe(1);
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER }).map((m) => m.id)).not.toContain(notes[0]!.id);

    const news = store.sendMessage({ project_id: project.id, author: AGENT, body: "Merged #12.", wakes: true }).message;
    store.ackMessage(news.id, true);
    clock.now += 10_000;
    const [settled] = store.settleAcks(10_000);
    const noteId = settled!.ack!.note_id!;
    clock.now += AFTER - 1;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER }).map((m) => m.id)).not.toContain(noteId);
    clock.now += 1;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER }).map((m) => m.id)).toEqual([noteId]);
    // The window's thread shows the 👍 went in by itself.
    const ack = store.windowThread(news.thread_id)!.messages.find((m) => m.id === news.id)!.ack!;
    expect(ack).toMatchObject({ deliver_now_by: "auto", note_at: store.message(noteId)!.created_at });
  });

  test("a tagged session's own wait: marked on its tag, not the owner's", () => {
    const { store, clock, asked } = setup();
    const reply = store.sendReply(asked.id, { words: "Parquet, and Pi checks the schema.", idempotency_key: "k1", tags: [{ host: "pi", session: "ses_pi", wakes: true }] }).reply!;
    clock.now += AFTER;
    const [marked] = store.autoSendDue("ses_pi", { afterMs: AFTER, tags: true });
    expect(marked!.tags![0]).toMatchObject({ session: "ses_pi", deliver_now_by: "auto" });
    expect(store.message(reply.id)!.deliver_now_at ?? null).toBeNull();
    // A connection that does not understand tags is never handed it, so never marks it.
    expect(store.autoSendDue("ses_pi", { afterMs: AFTER, tags: false })).toEqual([]);
    expect(store.autoSendDue("ses_a", { afterMs: AFTER }).map((m) => m.id)).toEqual([reply.id]);
  });
});

describe("the row's delivery while it waits on a busy session", () => {
  test("Undelivered: since its created_at; goes in by itself only where the connection can take it; after: auto_after_min", () => {
    const { store, clock, asked } = setup();
    const busy = { busy: true as boolean | null, send_now: true };
    store.setDeliveryPresence({ connection: () => busy, askerLive: () => true, autoSendAfterMs: AFTER });
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += 3 * 60_000;
    expect(store.listRow(asked.id)!.delivery).toMatchObject({
      state: "queued",
      reason: "working",
      send_now: true,
      waiting_since: reply.created_at,
      steerable: true,
      auto_send_at: new Date(Date.parse(reply.created_at) + AFTER).toISOString(),
    });
    // Its connection cannot take it mid-turn: grey, and it will not go in by itself.
    busy.send_now = false;
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ send_now: false, steerable: false, auto_send_at: null, waiting_since: reply.created_at });
    // Idle: not waiting on a busy agent.
    busy.busy = false;
    expect(store.listRow(asked.id)!.delivery!.waiting_since).toBeUndefined();

    busy.busy = true;
    busy.send_now = true;
    clock.now += 2 * 60_000;
    store.autoSendDue("ses_a", { afterMs: AFTER });
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ state: "sending", reason: "sending_now", auto_after_min: 5 });
    clock.now += 30_000;
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a" });
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ state: "delivered", auto_after_min: 5 });
  });

  test("the rule alone: no countdown from an older Inbox, none after a person's Send now", () => {
    const base = { delivered: false, undelivered: false, askerEnded: false, wakes: true, sendingNow: false, connection: { busy: true, send_now: true }, waitingSince: "2026-10-21T13:48:00.000Z" };
    expect(inboxDeliveryState(base).wait).toEqual({ since: base.waitingSince, steerable: true, autoSendAt: null });
    expect(inboxDeliveryState({ ...base, autoSendAfterMs: AFTER }).wait!.autoSendAt).toBe("2026-10-21T13:53:00.000Z");
    expect(inboxDeliveryState({ ...base, autoSendAfterMs: AFTER, nowBy: "person" }).wait!.autoSendAt).toBeNull();
    // Delivered by a person's Send now: no "went in by itself".
    expect(inboxDeliveryState({ ...base, delivered: true, nowBy: "person", nowAt: "2026-10-21T13:50:00.000Z" }).autoAfterMin).toBeUndefined();
  });
});
