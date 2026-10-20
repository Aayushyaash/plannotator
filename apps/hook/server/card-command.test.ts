/**
 * `plannotator card …` as real processes (approval "inbox-board", step 1):
 * the CLI's thin client over the Inbox's `card` tool. It starts a stopped
 * Inbox detached (no browser), keeps one card current in one command each,
 * makes the card the agent session's when it runs inside one, exits 1 with
 * the tool's own refusal and 2 on bad usage, and stays out of
 * `plannotator --help` (HIDDEN_SUBCOMMANDS). Every process gets a temp HOME
 * and data dir; only Inboxes these tests started are stopped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { HIDDEN_SUBCOMMANDS } from "./cli";
import { parseCardCommand } from "./card-command";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-card-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".plannotator");
  const project = join(root, "projects", "app");
  mkdirSync(project, { recursive: true });
  const browserMarker = join(root, "browser-opened");
  const browser = join(root, "fake-browser.sh");
  writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${browserMarker}'\n`);
  chmodSync(browser, 0o755);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: browser,
    BROWSER: browser,
    NO_BROWSER,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PLANNOTATOR_INBOX_CONNECT: "0",
  };
  return { root, dataDir, project, browserMarker, env };
}

type Box = ReturnType<typeof sandbox>;

async function card(box: Box, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry, "card", ...args], {
    cwd: box.project,
    env: { ...box.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const inbox = inboxEntryOf(box.dataDir);
  if (inbox && !started.some((s) => s.entry.pid === inbox.pid)) started.push({ entry: inbox, root: box.root });
  return { code, stdout, stderr };
}

async function plannotator(box: Box, args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], { cwd: box.project, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr };
}

describe("plannotator card", () => {
  test("create starts a stopped Inbox without a browser; move, say, ship and list keep the card current", async () => {
    const box = sandbox();
    const made = await card(box, ["create", "Hero scene timers", "--say", "lane started", "--json"]);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);
    const created = JSON.parse(made.stdout) as { card: { id: string; agent: unknown } };
    expect(created.card).toMatchObject({ column: "asked", said: "lane started" });
    // Outside an agent session, the card is nobody's in particular.
    expect(created.card.agent).toMatchObject({ kind: "agent", session: null });
    expect(existsSync(box.browserMarker)).toBe(false);
    const id = created.card.id;

    const moved = await card(box, ["move", id, "your_look", "--you", "pick one of five options"]);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain("Moved to Your look");
    expect(moved.stdout).toContain('You: "pick one of five options"');
    expect((await card(box, ["say", id, "--you", "pick one of five options, or none"])).code).toBe(0);
    expect((await card(box, ["move", id, "building", "--pr", "backnotprop/plannotator#2020"])).stdout).toContain("PRs backnotprop/plannotator#2020");
    expect((await card(box, ["ship", id, "--say", "merged"])).stdout).toContain("Shipped");

    const live = await card(box, ["list"]);
    expect(live.code).toBe(0);
    expect(live.stdout).toContain("0 cards");
    const all = await card(box, ["list", "--all", "--json"]);
    expect((JSON.parse(all.stdout) as { cards: { id: string; column: string }[] }).cards).toEqual([expect.objectContaining({ id, column: "shipped" })]);
  });

  test("inside a Claude Code session the card is that session's, and list shows the session's own", async () => {
    const box = sandbox();
    const session = { PLANNOTATOR_SESSION_TAG: "claude-code:0193abcd-1111" };
    const made = await card(box, ["create", "Delivery ticks", "--column", "building", "--json"], session);
    expect(made.code).toBe(0);
    expect(JSON.parse(made.stdout).card.agent).toEqual({ kind: "agent", host: "claude-code", session: "0193abcd-1111", name: "Claude Code" });
    await card(box, ["create", "Somebody else's"]);
    const mine = await card(box, ["list", "--json"], session);
    expect((JSON.parse(mine.stdout) as { cards: { title: string }[] }).cards.map((c) => c.title)).toEqual(["Delivery ticks"]);
    expect((JSON.parse((await card(box, ["list", "--anyone", "--json"], session)).stdout) as { total: number }).total).toBe(2);
  });

  test("a refusal exits 1 with the tool's code; bad usage exits 2", async () => {
    const box = sandbox();
    const id = (JSON.parse((await card(box, ["create", "Triage", "--json"])).stdout) as { card: { id: string } }).card.id;
    const iced = await card(box, ["move", id, "icebox"]);
    expect(iced.code).toBe(1);
    expect(iced.stdout).toBe("");
    expect(iced.stderr).toStartWith("card_icebox_person_only: Only the person puts a card in the Icebox");
    const dropped = await card(box, ["drop", id]);
    expect(dropped.code).toBe(2);
    expect(dropped.stderr).toContain("card drop needs: card_id, reason.");
    expect((await card(box, ["move", id, "someday"])).code).toBe(1);
    expect((await card(box, ["frob"])).code).toBe(2);
    expect((await card(box, ["create", "--frob"])).code).toBe(2);
    expect((await card(box, [])).code).toBe(2);
  });

  test("--help prints its usage; plannotator --help never lists it, and a typo is never pointed at it (unreleased)", async () => {
    const box = sandbox();
    const help = await card(box, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("plannotator card create <title>");
    expect(HIDDEN_SUBCOMMANDS.has("card")).toBe(true);
    const top = await plannotator(box, ["--help"]);
    expect(top.stdout).toContain("plannotator inbox");
    expect(top.stdout).not.toContain("plannotator card");
    expect((await plannotator(box, ["cardd"])).stderr).not.toContain("plannotator card");
  });
});

describe("parseCardCommand", () => {
  test("maps words and flags onto the tool's fields", () => {
    expect(parseCardCommand(["move", "crd_x", "building", "--say", "PR open", "--pr", "o/r#1", "--project", "../web", "--json"])).toEqual({
      ok: true,
      op: "move",
      args: { op: "move", card_id: "crd_x", column: "building", say: "PR open", pr: "o/r#1" },
      project: "../web",
      json: true,
    });
    expect(parseCardCommand(["create", "--thread", "msg_1"])).toMatchObject({ ok: true, args: { op: "create", thread_id: "msg_1" } });
    expect(parseCardCommand(["say", "crd_x", "a", "b"])).toMatchObject({ ok: false });
    expect(parseCardCommand(["say", "crd_x", "a", "--say", "b"])).toMatchObject({ ok: false });
    expect(parseCardCommand(["create"])).toMatchObject({ ok: false });
    expect(parseCardCommand(["list", "--all"])).toMatchObject({ ok: true, args: { op: "list", include_resolved: true } });
  });
});
