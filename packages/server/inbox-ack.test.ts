/**
 * 👍 Looks good (design record "inbox-acknowledge", approved 2026-10-15)
 * through the Inbox's real doors: `POST /api/inbox/messages/:id/ack` on a
 * running Inbox (temp data dir, loopback), the agent side over the official
 * MCP client, the wake over the bridge. Silent: nothing is sent and no
 * session is woken; the agent sees the ack only after the Undo window
 * (shortened here), in read_thread and as wait_for_reply's `acknowledged`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxMessageWire } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DELAY = 150;
const SESSION = "ses_ack";

const QUESTION = [
  "One thing first:",
  "",
  ":::question",
  "Ship it today?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

async function setup(body = "Merged #1937. CI is green on main. Nothing needs you here.") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ack-")));
  roots.push(root);
  const project = join(root, "plannotator");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: DELAY });
  servers.push(server);
  const client = new Client({ name: "inbox-ack-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (text: string, replyTo?: string) =>
    (
      (await client.callTool({
        name: "send_message",
        arguments: { project_path: project, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code", body: text, ...(replyTo ? { reply_to: replyTo } : {}) },
      })) as { structuredContent: { thread_id: string; message_id: string } }
    ).structuredContent;
  const sent = await send(body);
  return { server, client, send, threadId: sent.thread_id, messageId: sent.message_id };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const ack = (server: InboxServer, messageId: string, on = true, extra: Record<string, unknown> = {}) =>
  post(server, `/api/inbox/messages/${messageId}/ack`, { serverSession: server.serverSession, ...(on ? {} : { ack: false }), ...extra });

async function rowOf(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function windowMessage(server: InboxServer, threadId: string, messageId: string): Promise<InboxMessageWire> {
  const model = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: { messages: InboxMessageWire[] } };
  return model.thread.messages.find((m) => m.id === messageId)!;
}

async function readThread(client: Client, threadId: string) {
  return (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId } })) as {
    structuredContent: { thread: { messages: (InboxMessageWire & { ack?: unknown })[] } };
  };
}

async function waitForReply(client: Client, threadId: string, seconds = 1) {
  return (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: threadId, agent_session: SESSION, timeout_seconds: seconds } })) as {
    content: { text: string }[];
    structuredContent: { status: string; acks?: { message_id: string; label: string }[]; cursor: number };
  };
}

async function poll(server: InboxServer, session: string) {
  const response = await fetch(url(server, INBOX_BRIDGE_POLL_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, waitMs: 0 }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

describe("POST /api/inbox/messages/:id/ack", () => {
  test("records the ack on the agent's message, marks the thread read, and the row says Looks good; Undo takes both back", async () => {
    const { server, threadId, messageId } = await setup();
    expect((await rowOf(server, threadId)).section).toBe("new");
    const res = await ack(server, messageId);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { message: InboxMessageWire; thread: InboxListRow };
    expect(answer.message.ack).toMatchObject({ label: "Looks good", settled_seq: null, seen_at: null });
    expect(answer.thread.section).toBe("quiet");
    expect(answer.thread.read_at).not.toBeNull();
    expect(answer.thread.ack).toMatchObject({ label: "Looks good" });
    // Silent: no message was written, nothing was sent.
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ label: "Looks good" });

    const back = await ack(server, messageId, false);
    expect(back.status).toBe(200);
    const undone = (await back.json()) as { message: InboxMessageWire; thread: InboxListRow };
    expect(undone.message.ack).toBeNull();
    expect(undone.thread.read_at ?? null).toBeNull();
    expect(undone.thread.ack ?? null).toBeNull();
    expect(undone.thread.section).toBe("new");
  });

  test("a second 👍 changes nothing; an agent's next message ends the read and the row's Looks good", async () => {
    const { server, threadId, messageId, send } = await setup();
    await ack(server, messageId);
    const lines = server.store.cursor();
    expect((await ack(server, messageId)).status).toBe(200);
    expect(server.store.cursor()).toBe(lines);
    await send("Next I'm looking at the stepping bug.", messageId);
    const row = await rowOf(server, threadId);
    expect(row.section).toBe("new");
    expect(row.ack ?? null).toBeNull();
    // The ack stays on the older message as history.
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ label: "Looks good" });
  });

  test("refusals: a question open or picked, an older agent message, a person's message, an archived thread, the guards", async () => {
    const asking = await setup(QUESTION);
    const open = await ack(asking.server, asking.messageId);
    expect(open.status).toBe(409);
    expect(((await open.json()) as { code: string }).code).toBe("question_open");

    const { server, threadId, messageId, send } = await setup();
    const later = await send("One more update.", messageId);
    const stale = await ack(server, messageId);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("ack_stale");

    const replied = await post(server, `/api/inbox/messages/${later.message_id}/reply`, { idempotency_key: "r1", words: "cool" });
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    const person = await ack(server, replyId);
    expect(person.status).toBe(422);
    expect(((await person.json()) as { code: string }).code).toBe("ack_not_allowed");
    // The person already replied after the agent's latest message: the reply is the answer, and the row stays Sent.
    const afterReply = await ack(server, later.message_id);
    expect(afterReply.status).toBe(409);
    expect(((await afterReply.json()) as { code: string }).code).toBe("ack_after_reply");
    expect((await rowOf(server, threadId)).section).toBe("sent");

    expect((await post(server, `/api/inbox/messages/${later.message_id}/ack`,{}, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await ack(server, later.message_id, true, { serverSession: "an-older-inbox" })).status).toBe(409);
    expect((await fetch(url(server, `/api/inbox/messages/${later.message_id}/ack`))).status).toBe(405);
    expect((await ack(server, later.message_id, true, { ack: "yes" })).status).toBe(422);
    expect((await ack(server, "msg_00000000000000000000000000")).status).toBe(404);

    await post(server, `/api/inbox/messages/${threadId}/resolve`, { resolved: true });
    const archived = await ack(server, later.message_id);
    expect(archived.status).toBe(409);
    expect(((await archived.json()) as { code: string }).code).toBe("thread_resolved");
  });

  test("Move back on the thread withdraws the 👍 too: the agent never sees it", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    const back = await post(server, `/api/inbox/threads/${threadId}/unread`, { serverSession: server.serverSession });
    expect(back.status).toBe(200);
    expect((await windowMessage(server, threadId, messageId)).ack).toBeNull();
    const row = await rowOf(server, threadId);
    expect(row.read_at ?? null).toBeNull();
    expect(row.ack ?? null).toBeNull();
    await Bun.sleep(DELAY + 400);
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
    expect((await waitForReply(client, threadId)).structuredContent.status).toBe("waiting");
  });

  test("an already-read thread stays read when the 👍 is taken back", async () => {
    const { server, threadId, messageId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    await ack(server, messageId);
    await ack(server, messageId, false);
    const row = await rowOf(server, threadId);
    expect(row.read_at).not.toBeNull();
    expect(row.ack ?? null).toBeNull();
  });
});

describe("what the agent sees", () => {
  test("read_thread carries the ack only after the Undo window, and reading it marks it seen", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    // Inside the window: not there yet, in the thread or in the list of threads.
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
    const listed = (await client.callTool({ name: "read_thread", arguments: { project_path: server.store.project(server.store.message(threadId)!.project_id)!.root, agent_session: SESSION } })) as {
      structuredContent: { threads: Record<string, unknown>[] };
    };
    expect(listed.structuredContent.threads.map((t) => t.thread_id)).toEqual([threadId]);
    expect(listed.structuredContent.threads[0]!).not.toHaveProperty("ack");
    await Bun.sleep(DELAY + 400);
    const read = (await readThread(client, threadId)).structuredContent.thread.messages[0]!;
    expect(read.ack).toEqual({ label: "Looks good", at: expect.any(String) });
    const seen = (await windowMessage(server, threadId, messageId)).ack!;
    expect(seen.seen_at).toEqual(expect.any(String));
    expect(seen.settled_seq).toEqual(expect.any(Number));
  });

  test("wait_for_reply returns acknowledged after the window (a held wait and a later call), and it is not a person reply", async () => {
    const { server, client, threadId, messageId } = await setup();
    const held = waitForReply(client, threadId, 5);
    await Bun.sleep(50);
    await ack(server, messageId);
    const waited = await held;
    expect(waited.structuredContent.status).toBe("acknowledged");
    expect(waited.structuredContent.acks).toEqual([{ message_id: messageId, label: "Looks good", at: expect.any(String) }]);
    expect(waited.content[0]!.text).toContain("No reply is coming");
    // Nothing the person sent: the thread still holds the one agent message.
    expect(server.store.thread(threadId)!.messages.map((m) => m.author.kind)).toEqual(["agent"]);
    expect((await windowMessage(server, threadId, messageId)).ack!.seen_at).toEqual(expect.any(String));
    // Without a cursor it answers again; with the cursor it waits.
    expect((await waitForReply(client, threadId)).structuredContent.status).toBe("acknowledged");
    const next = (await client.callTool({
      name: "wait_for_reply",
      arguments: { thread_id: threadId, agent_session: SESSION, timeout_seconds: 1, cursor: waited.structuredContent.cursor },
    })) as { structuredContent: { status: string } };
    expect(next.structuredContent.status).toBe("waiting");
  });

  test("a 👍 already given never answers a later wait across every thread (no thread, no cursor)", async () => {
    const { server, client, messageId } = await setup("Deploy done.");
    await ack(server, messageId);
    await Bun.sleep(DELAY + 400);
    const waitAll = async () =>
      (await client.callTool({ name: "wait_for_reply", arguments: { agent_session: SESSION, timeout_seconds: 1 } })) as {
        structuredContent: { status: string; thread_id?: string };
      };
    // The first wait across threads gets the 👍 (the agent had not seen it).
    expect((await waitAll()).structuredContent.status).toBe("acknowledged");
    // Then the agent asks something in another thread and waits on everything it asked: the old 👍 is not the answer.
    const asked = (await client.callTool({
      name: "send_message",
      arguments: {
        project_path: server.store.project(server.store.message(messageId)!.project_id)!.root,
        agent_session: SESSION,
        thread: "db",
        body: [":::question", "Which database?", "", "- [ ] Postgres", "- [ ] SQLite", ":::"].join("\n"),
      },
    })) as { structuredContent: { thread_id: string } };
    expect(asked.structuredContent.thread_id).not.toBe(messageId);
    expect((await waitAll()).structuredContent.status).toBe("waiting");
  });

  test("an Undo inside the window: wait_for_reply never sees it, read_thread neither", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    await ack(server, messageId, false);
    await Bun.sleep(DELAY + 400);
    expect((await waitForReply(client, threadId)).structuredContent.status).toBe("waiting");
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
  });

  test("no wake: the bridge hands the session nothing, before or after the window", async () => {
    const { server, messageId } = await setup();
    await ack(server, messageId);
    expect(await poll(server, SESSION)).toEqual([]);
    await Bun.sleep(DELAY + 400);
    expect(await poll(server, SESSION)).toEqual([]);
    expect(server.store.pendingReplies(SESSION)).toEqual([]);
  });

  test("an ack a stop interrupted inside its window is settled at the next start", async () => {
    const { server, threadId, messageId } = await setup();
    await ack(server, messageId);
    const dataDir = join(server.store.dir, "..");
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    await Bun.sleep(DELAY + 100);
    const next = await startInboxServer({ dataDir, setAsideDelayMs: DELAY });
    servers.push(next);
    await Bun.sleep(100);
    expect(next.store.message(messageId)!.ack!.settled_seq).toEqual(expect.any(Number));
    expect(next.store.thread(threadId)!.messages).toHaveLength(1);
  });
});
