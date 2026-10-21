/**
 * Re-ask (approval "inbox-reask") through the server's real doors: the
 * window's route and its guards, the connection's poll (the wake's own
 * line), an MCP agent that receives the note with wait_for_reply and
 * supersedes its old questions through send_message, and the phone's door.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_REASK_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  inboxReaskRedirectedLine,
  inboxRedirectedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(options: { phones?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, ...(options.phones ? { phones: true } : {}) });
  servers.push(server);
  const client = new Client({ name: "inbox-reask-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string, extra: string[] = []) => [":::question", prompt, "", ...extra, "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function send(client: Client, project: string, session: string, args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...args },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

/** Three open questions over two messages of one session. */
async function seed(client: Client, project: string, session = "ses-a") {
  const first = await send(client, project, session, { body: `Two calls.\n\n${block("Backfill ledger first?")}\n\n${block("Keep the old webhook?")}` });
  const second = await send(client, project, session, { reply_to: first.message_id, body: `One more.\n\n${block("Move refunds now?")}` });
  return { thread: first.thread_id, first: first.message_id, second: second.message_id };
}

function post(server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const reask = (server: InboxServer, id: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  post(server, `/api/inbox/messages/${id}/reask`, { serverSession: server.serverSession, ...body }, headers);

async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}
async function row(server: InboxServer, id: string): Promise<InboxListRow> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads).find((t) => t.thread_id === id)!;
}
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

describe("Re-ask over the window's route", () => {
  test("writes the note, puts the row in Sent, and answers a replay with the same note", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    expect((await row(server, t.thread)).section).toBe("waiting");
    const response = await reask(server, t.second, { idempotency_key: "k1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reply: { id: string; reask: string[] }; replayed: boolean };
    expect(body.reply.reask).toHaveLength(3);
    expect(body.replayed).toBe(false);
    const after = await row(server, t.thread);
    expect(after.section).toBe("sent");
    expect(after.reask_pending).toBe(true);
    const replay = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string }; replayed: boolean };
    expect(replay).toMatchObject({ reply: { id: body.reply.id }, replayed: true });
    expect((await thread(server, t.thread)).messages).toHaveLength(3);
  });

  test("guards: another site, a stale tab, an unknown message, no key, a session that is not live, nothing left to ask; nothing written", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    expect((await reask(server, t.second, { idempotency_key: "x1" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await reask(server, t.second, { idempotency_key: "x2" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await post(server, `/api/inbox/messages/${t.second}/reask`, { serverSession: "stale", idempotency_key: "x3" })).status).toBe(409);
    expect((await reask(server, "msg_01K7000000000000000000NONE", { idempotency_key: "x4" })).status).toBe(404);
    expect((await reask(server, t.second, {})).status).toBe(422);
    const notLive = await reask(server, t.second, { idempotency_key: "x5", to: { session: "ses-gone" } });
    expect(notLive.status).toBe(409);
    expect(((await notLive.json()) as { code: string }).code).toBe("session_not_live");
    expect((await thread(server, t.thread)).messages).toHaveLength(2);
    // A person's message takes no Re-ask.
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string } };
    expect((await reask(server, note.reply.id, { idempotency_key: "x6" })).status).toBe(422);
    // A thread with nothing open: 409 nothing_to_reask.
    const lone = await send(client, project, "ses-z", { body: "Just an update, nothing to ask." });
    const nothing = await reask(server, lone.message_id, { idempotency_key: "x7" });
    expect(nothing.status).toBe(409);
    expect(((await nothing.json()) as { code: string }).code).toBe("nothing_to_reask");
  });
});

describe("Re-ask reaches the agent", () => {
  test("a waking connection gets the note with the Re-ask wake line, not the reply's", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string; body: string } };
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0 });
    const [command] = parseInboxBridgeCommands(await polled.text());
    expect(command).toMatchObject({ type: "reply", id: note.reply.id, reask: true });
    const wake = inboxWakeText(command!);
    expect(wake.split("\n")[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(wake).not.toContain(INBOX_WAKE_INSTRUCTION);
    expect(wake.endsWith(note.reply.body)).toBe(true);
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: note.reply.id })).status).toBe(200);
    // Delivered, and still Sent: the agent has not asked again yet.
    expect((await row(server, t.thread)).section).toBe("sent");
  });

  test("an MCP agent reads the note with wait_for_reply, re-asks with Replaces: lines and drops one with supersedes", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    const note = (await (await reask(server, t.second, { idempotency_key: "k1" })).json()) as { reply: { id: string; reask: string[] } };
    const waited = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: t.thread, agent_session: "ses-a", timeout_seconds: 1 } });
    const text = JSON.stringify(waited.content);
    expect(text).toContain("Please ask your 3 open questions in this thread again");
    expect(text).toContain(`reply_to ${note.reply.id}`);
    // The agent re-asks the first two and drops the third, as the note says.
    const [q1, q2, q3] = note.reply.reask as [string, string, string];
    const answer = await send(client, project, "ses-a", {
      reply_to: note.reply.id,
      supersedes: [q3],
      body: `Here they are; refunds already moved.\n\n${block("Backfill ledger first?", [`Replaces: ${q1}`, ""])}\n\n${block("Keep the old webhook?", [`Replaces: ${q2}`, ""])}`,
    });
    const after = await thread(server, t.thread);
    const old = after.messages.filter((m) => m.id === t.first || m.id === t.second).flatMap((m) => m.questions ?? []);
    expect(old.map((q) => q.state)).toEqual(["superseded", "superseded", "superseded"]);
    expect(old[2]!.superseded_by).toEqual({ message_id: answer.message_id, key: null });
    expect(old[0]!.superseded_by?.key).not.toBeNull();
    const r = await row(server, t.thread);
    expect(r.reask_pending).toBe(false);
    expect(r.section).toBe("waiting");
  });
});

describe("Re-ask to another session (the asker ended)", () => {
  test("the note names whose questions they are, and the wake says the questions are another session's", async () => {
    const { server, client, project } = await setup();
    const t = await seed(client, project);
    // Another session of the project is live (it polled).
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const sent = await reask(server, t.second, { idempotency_key: "k1", to: { host: "claude-code", session: "ses-c" } });
    expect(sent.status).toBe(200);
    const note = ((await sent.json()) as { reply: { id: string; body: string } }).reply;
    expect(note.body.startsWith("Please ask the 3 open questions Claude Code asked in this thread again")).toBe(true);
    const polled = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-c", host: "claude-code", project_path: project, waitMs: 0 });
    const [command] = parseInboxBridgeCommands(await polled.text());
    expect(command).toMatchObject({ id: note.id, reask: true, redirected_from: "Claude Code" });
    const lines = inboxWakeText(command!).split("\n");
    expect(lines[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(lines[2]).toBe(inboxReaskRedirectedLine("Claude Code", note.id));
    expect(lines[2]).not.toBe(inboxRedirectedLine("Claude Code", note.id));
  });
});

describe("Re-ask on the phone's door", () => {
  test("POST device/messages/:id/reask goes to the window's route", async () => {
    const { server, client, project } = await setup({ phones: true });
    const t = await seed(client, project);
    const made = (await (await post(server, "/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const paired = (await (await post(server, "/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string };
    const door = (key: string) =>
      fetch(`${base(server)}/api/inbox/device/messages/${t.second}/reask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: key }),
      });
    const first = await door("00000000-0000-4000-8000-000000000061");
    expect(first.status).toBe(200);
    const again = await door("00000000-0000-4000-8000-000000000061");
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await row(server, t.thread)).section).toBe("sent");
  });
});
