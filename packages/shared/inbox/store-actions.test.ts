/**
 * To-dos (approval "inbox-next-actions"): the store's rules, on a real store in
 * a temp dir on a clock the test moves. Failures to catch: a Done sent inside
 * its Undo window, or sent twice; an Undo after it went; a to-do read as a
 * question by picks, skips or the reply's sections; Mark read leaving one open
 * or closing one already on its way; the agent's `done` reaching another
 * thread, a question, or a to-do no longer open; a replay that changes any of
 * it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_ACTIONS_HEADING, inboxActionKey } from "@plannotator/core/inbox-actions";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-actions-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: Date.parse("2026-10-21T15:12:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const UNDO_MS = 10_000;

const BODY = [
  "Release 4.2 is built.",
  "",
  ":::action",
  "Approve the production deploy on Vercel",
  "The build passed every check.",
  "Where: https://vercel.com/acme/web/deployments",
  "Stopped: release 4.2 waits on it",
  "Watching: the deployment",
  ":::",
  "",
  ":::question",
  "Announce it in #releases?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

function setup(dir?: string) {
  const opened = open(dir);
  const project = opened.store.ensureProject({ name: "web", root: "/work/web" });
  const asked = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const all = opened.store.questionsOf(asked.id);
  const action = all.find((q) => q.kind === "action")!;
  const question = all.find((q) => q.kind !== "action")!;
  return { ...opened, project, asked, action, question };
}

const rowOf = (store: InboxStore, threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;
const actionOf = (store: InboxStore, messageId: string): InboxQuestion => store.questionsOf(messageId).find((q) => q.kind === "action")!;

describe("a :::action block becomes a to-do record", () => {
  test("kept as a question record of kind action, numbered on its own; the thread is Stopped on you and its row counts a to-do", () => {
    const { store, asked, action, question } = setup();
    expect(action).toMatchObject({
      key: inboxActionKey("Approve the production deploy on Vercel"),
      kind: "action",
      position: 0,
      state: "open",
      stopped: "release 4.2 waits on it",
      context: "The build passed every check.",
      action: { where: "vercel.com", where_url: "https://vercel.com/acme/web/deployments", run: null, watching: "the deployment" },
      action_result: null,
    });
    expect(question).toMatchObject({ kind: "single", position: 0, state: "open" });
    const row = rowOf(store, asked.thread_id);
    expect(row.section).toBe("stopped");
    expect(row.questions).toMatchObject({ open: 2, actions: 1, stopped: true });
    // The question's own subject: the first question's prompt, never the to-do (only a to-do and words: the first line).
    expect(row.subject).toBe("Announce it in #releases?");
  });

  test("a message of a to-do alone sits in Stopped on you by its Stopped: line, and its subject is the body's first line", () => {
    const { store, project } = open();
    const p = store.ensureProject({ name: "web", root: "/work/web2" });
    void project;
    const m = store.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nTouch your YubiKey\nStopped: the signing step\n:::" }).message;
    expect(rowOf(store, m.thread_id)).toMatchObject({ section: "stopped", subject: "Touch your YubiKey", questions: { open: 1, actions: 1 } });
  });
});

describe("Done and Can't do it", () => {
  test("Done is recorded at once, nothing is sent inside the Undo window, then one reply goes with the section", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", note: "Approved." });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", action_result: { outcome: "done", note: "Approved.", by: "person" } });
    // Inside the window: nothing written, nothing for the agent.
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);
    expect(store.actionsPending()).toBe(1);
    // Waits on nobody's Send: the row is not "Answered, not sent".
    expect(rowOf(store, asked.thread_id).answered_not_sent).toBe(false);
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply).toBeDefined();
    expect(reply!).toMatchObject({ author: { kind: "person" }, reply_to: asked.id, action_report: [`${asked.id}/${action.key}`] });
    expect(reply!.body.startsWith("Did 1 action.\n\n## Actions you asked for\n\n1 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nDone, ")).toBe(true);
    expect(reply!.body.endsWith("\nNote: Approved.")).toBe(true);
    expect(reply!.body).not.toContain(INBOX_ACTIONS_HEADING.toUpperCase());
    expect(actionOf(store, asked.id)).toMatchObject({ state: "sent", sent_reply_id: reply!.id });
    // The reply machinery hands it to the asking session, once.
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([reply!.id]);
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.actionsPending()).toBe(0);
    // Sent: no Undo, no second Done.
    expect(() => store.markAction(asked.id, action.key, { outcome: null })).toThrow(InboxError);
    expect(() => store.markAction(asked.id, action.key, { outcome: "done" })).toThrow(/already sent/);
    // The question in the same message is still open: the row is in Sent while the reply is the last message.
    expect(rowOf(store, asked.thread_id).section).toBe("waiting");
  });

  test("Undo inside the window takes it back with nothing sent; Can't do it needs a reason and goes word for word", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    store.markAction(asked.id, action.key, { outcome: null });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "open", action_result: null });
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(() => store.markAction(asked.id, action.key, { outcome: "cant" })).toThrow(/say why/);
    store.markAction(asked.id, action.key, { outcome: "cant", note: "I'm not in the acme team; ask Dana." });
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply!.body).toBe(
      "Couldn't do 1 action.\n\n## Actions you asked for\n\n0 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nCan't do it: I'm not in the acme team; ask Dana.",
    );
  });

  test("a to-do is never a question: picks, Sends and skips that name it are refused, and a reply's sections leave it out", () => {
    const { store, asked, action, question } = setup();
    expect(() => store.savePicks(asked.id, [{ key: action.key, revision: 0, answer: { v: 1, key: action.key, kind: "single", prompt: action.prompt, selected: [] } as never }])).toThrow(/is a to-do/);
    expect(() => store.sendReply(asked.id, { idempotency_key: "k1", words: "", skip: [action.key] })).toThrow(/is a to-do/);
    expect(() => store.markAction(asked.id, question.key, { outcome: "done" })).toThrow(/is a question/);
    const { reply } = store.sendReply(asked.id, { idempotency_key: "k2", words: "Looking now." });
    expect(reply.body).toBe("Looking now.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.");
    expect(actionOf(store, asked.id).state).toBe("open");
  });
});

describe("Mark read", () => {
  test("sets an open to-do aside like a question, the note lists it as A1, and Undo opens it again", () => {
    const { store, clock, asked } = setup();
    store.markRead(asked.thread_id, true);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", action_result: null });
    expect(actionOf(store, asked.id).set_aside_at).not.toBeNull();
    clock.now += UNDO_MS;
    const [note] = store.tellSetAside(asked.thread_id, UNDO_MS);
    expect(note!.body.startsWith(INBOX_SET_ASIDE_HEADING)).toBe(true);
    expect(note!.body).toContain("- Q1. Announce it in #releases?\n- A1. Approve the production deploy on Vercel");
    store.markRead(asked.thread_id, false);
    expect(actionOf(store, asked.id).state).toBe("open");
  });

  test("leaves a to-do already marked Done (its Undo window running) on its way", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    store.markRead(asked.thread_id, true);
    expect(actionOf(store, asked.id).state).toBe("picked");
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toHaveLength(1);
  });
});

describe("the agent marks its own to-do done", () => {
  test("done closes it as seen by the agent, nothing is sent; a Done the person pressed inside the window is never sent", () => {
    const { store, clock, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    const ref = `${asked.id}/${action.key}`;
    const result = store.sendMessage({ project_id: project.id, author: AGENT, body: "The deployment is Ready.", reply_to: asked.id, done: [ref] });
    expect(result.done).toEqual([ref]);
    expect(result.message.done).toEqual([ref]);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", action_result: { outcome: "done", by: "agent", message_id: result.message.id } });
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);
  });

  test("refuses another thread, a question, an unknown id and a to-do no longer open, writing nothing", () => {
    const { store, project, asked, action, question } = setup();
    const other = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: "elsewhere", thread: "other" }).message;
    const before = store.cursor();
    const attempt = (done: string[], replyTo = asked.id) => () => store.sendMessage({ project_id: project.id, author: AGENT, body: "x", reply_to: replyTo, done });
    expect(attempt([`${asked.id}/${question.key}`])).toThrow(/not a to-do's id/);
    expect(attempt([`${asked.id}/a-00000000`])).toThrow(/has no to-do/);
    expect(attempt([`${asked.id}/${action.key}`], other.id)).toThrow(/another thread/);
    expect(attempt(["nonsense"])).toThrow(/invalid_done|not a to-do's id/);
    expect(store.cursor()).toBe(before);
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, done: [`${asked.id}/${action.key}`] });
    expect(attempt([`${asked.id}/${action.key}`])).toThrow(/not open/);
    try {
      attempt(["nonsense"])();
    } catch (error) {
      expect((error as InboxError).code).toBe("invalid_done");
    }
  });

  test("an idempotent retry with another `done` is refused", () => {
    const { store, project, asked, action } = setup();
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k", done: [`${asked.id}/${action.key}`] });
    expect(() => store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k" })).toThrow(/idempotency_key/);
    const replay = store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k", done: [`${asked.id}/${action.key}`] });
    expect(replay).toMatchObject({ replayed: true, done: [`${asked.id}/${action.key}`] });
  });
});

describe("a replay from disk", () => {
  test("reads every to-do state back the same, a Done inside its window included", () => {
    const first = setup();
    const { store, clock, asked, action, project } = first;
    store.markAction(asked.id, action.key, { outcome: "done", note: "ok" });
    const second = store.sendMessage({ project_id: project.id, author: AGENT, body: ":::action\nSign in to npm\nRun: npm login\n:::", reply_to: asked.id }).message;
    const npm = actionOf(store, second.id);
    store.markAction(second.id, npm.key, { outcome: "cant", note: "No 2FA device here." });
    clock.now += UNDO_MS;
    store.settleActions(UNDO_MS);
    const third = store.sendMessage({ project_id: project.id, author: AGENT, body: ":::action\nTouch your key\n:::", reply_to: asked.id }).message;
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Signed.", reply_to: third.id, done: [third.id] });
    const wire = (s: InboxStore) => [asked.id, second.id, third.id].map((id) => s.questionsOf(id));
    const reopened = InboxStore.open(first.dir, { now: () => new Date(clock.now) });
    expect(wire(reopened)).toEqual(wire(store));
    expect(reopened.listRows()).toEqual(store.listRows());
  });
});
