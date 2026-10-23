/**
 * A whole guide run against the FAKE ACP agent (tests/fake-acp-agent.ts):
 * the extension's ACP client starts it, it starts the builder relay script
 * from `session/new`, calls the guide_* tools through it, asks for a
 * permission, reports cost, and finishes. No real agent ever runs here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuideGeneration, type GenerationDeps, type GenerationInput } from "./generation";
import { startRelayHost, type RelayHost } from "./mcp/relay-host";
import { changedFilesFromPatch } from "./sources/git";
import { listDraftRecords, loadDraftRecord, loadSavedGuide, listRecent } from "./store";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "tests", "fake-acp-agent.ts");
const RELAY_SCRIPT = join(import.meta.dir, "mcp", "relay-script.ts");

function addedFilePatch(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

let work: string;
let relay: RelayHost;
let repoN = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-gen-"));
  relay = await startRelayHost({ serverVersion: "test" });
});

afterAll(async () => {
  await relay.close();
  rmSync(work, { recursive: true, force: true });
});

interface World {
  input: GenerationInput;
  deps: GenerationDeps;
  log: () => Array<Record<string, any>>;
  permissions: string[];
}

function world(steps: unknown[], options: { pace?: number; resume?: GenerationInput["resume"]; choose?: string; script?: Record<string, unknown> } = {}): World {
  const root = join(work, `repo-${++repoN}`);
  mkdirSync(join(root, "src"), { recursive: true });
  const files: Record<string, string[]> = {
    "src/retryPolicy.ts": ["export function computeBackoff(attempt: number) {", "  return 2 ** attempt;", "}"],
    "src/deliver.ts": ["import { computeBackoff } from './retryPolicy';", "export function deliver() {", "  return computeBackoff(1);", "}"],
    "src/deliver.test.ts": ["test('x', () => {});"],
  };
  for (const [p, lines] of Object.entries(files)) writeFileSync(join(root, p), `${lines.join("\n")}\n`);
  const rawPatch = Object.entries(files).map(([p, l]) => addedFilePatch(p, l)).join("");
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "agent.log");
  writeFileSync(scriptPath, JSON.stringify({ steps, pace: options.pace ?? 0, ...options.script }));
  const permissions: string[] = [];
  const input: GenerationInput = {
    repoKey: `test__repo-${repoN}`,
    source: {
      kind: "local",
      repoRoot: root,
      headRoot: root,
      repoName: "checkout-service",
      label: "Local changes",
      branch: "feat/retries",
      headSha: "9b07e4d0000000000000000000000000000000",
      baseSha: "3f2c1a9000000000000000000000000000000000",
      baseLabel: "main",
      workingTree: true,
    },
    rawPatch,
    files: changedFilesFromPatch(rawPatch),
    agent: { id: "claude-code", label: "Claude Code", model: { id: "sonnet", label: "Sonnet" }, effort: { id: "low", label: "Low" } },
    instructions: "Keep chapters short.",
    ...(options.resume && { resume: options.resume }),
  };
  const deps: GenerationDeps = {
    relay,
    agentLaunch: (cwd) => ({ command: process.execPath, args: [FAKE_AGENT], cwd, env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } }),
    mcpServer: { command: process.execPath, args: [RELAY_SCRIPT] },
    clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: "test" },
    requestPermission: async (req) => {
      permissions.push(req.toolCall.title ?? "");
      const pick = req.options.find((o) => o.optionId === (options.choose ?? "allow-once"))!;
      return { outcome: { outcome: "selected", optionId: pick.optionId } };
    },
    resolveSymbol: async (name) => (name === "computeBackoff" ? { status: "found", path: "src/retryPolicy.ts", line: 1 } : { status: "missing" }),
    checkMermaid: async () => ({ ok: true, checked: true }),
  };
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { input, deps, log, permissions };
}

const header = { mcp: { name: "guide_set_header", args: { title: "Retry failed webhook deliveries", intent: "Deliveries retry with backoff." } } };
const ch1 = { mcp: { name: "guide_add_chapter", args: { title: "The retry budget", overview: "A policy decides how often to retry." } } };
const ch2 = { mcp: { name: "guide_add_chapter", args: { title: "Delivery loop learns to back off", overview: "The loop backs off." } } };
const place = (file: string, chapter: string, extra: Record<string, unknown> = {}) => ({ mcp: { name: "guide_place_file", args: { file, chapter, summary: `What ${file} does.`, ...extra } } });

describe("guide generation over ACP", () => {
  afterEach(() => {});

  it("runs a whole guide: messages, tool calls, a permission, builder calls with a refused one, cost, finish", async () => {
    const w = world([
      { say: "Reading the change first." },
      { tool: { title: "Read src/deliver.ts", locations: [{ path: "src/deliver.ts", line: 2 }] } },
      { permission: { title: "Run git log --oneline" } },
      header,
      ch1,
      ch2,
      place("src/retryPolicy.ts", "c1", { focus: [{ start: 1, end: 3 }] }),
      place("src/deliver.test.ts", "c2"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start at [computeBackoff](symbol:computeBackoff), then [chapter 2](chapter:2).", diagram: { kind: "mermaid", source: 'flowchart LR\n d-->b\n click b "symbol:computeBackoff"' } } } },
      { mcp: { name: "guide_finish" } },
      place("src/deliver.ts", "c2"),
      { usage: { cost: 0.17 } },
      { mcp: { name: "guide_read" } },
      { mcp: { name: "guide_finish" } },
    ]);
    const gen = new GuideGeneration(w.input, w.deps);
    const statuses: string[] = [];
    gen.onChange((s) => {
      if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status);
    });
    await gen.run();

    expect(gen.state.status).toBe("finished");
    expect(statuses).toContain("running");
    expect(gen.state.cost).toEqual({ amount: 0.17, currency: "USD" });
    expect(gen.state.appliedModel).toBe("Sonnet");
    expect(gen.state.appliedEffort).toBe("Low");

    const log = w.log();
    expect(log.find((e) => e.event === "initialize")?.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } });
    // Local changes are the user's own checkout: their project settings apply, no _meta override.
    expect(log.find((e) => e.event === "newSession")?.meta).toBeNull();
    expect(log.find((e) => e.event === "mcpReady")?.tools).toContain("guide_place_file");
    expect(log.filter((e) => e.event === "setConfig").map((e) => `${e.configId}=${e.value}`)).toEqual(["model=sonnet", "effort=low"]);
    const prompt = log.find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain("- src/deliver.ts (+4/-0)");
    expect(prompt.text).toContain("guide_finish");
    expect(prompt.text).toContain("Keep chapters short.");
    expect(prompt.text).not.toContain("## Speed");
    expect(log.find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(w.permissions).toEqual(["Run git log --oneline"]);
    const calls = log.filter((e) => e.event === "mcpCall");
    expect(calls.find((c) => c.name === "guide_place_file" && c.isError)?.text).toContain("already in chapter 2 (c2). Use guide_move_file");
    expect(calls.filter((c) => c.name === "guide_finish")[0].text).toContain("neither placed nor marked not in a chapter: `src/deliver.ts`");
    expect(calls.filter((c) => c.name === "guide_finish")[1].text).toContain("Saved \"Retry failed webhook deliveries\": 2 chapters and an overview.");

    // The activity stream: the agent's message, its own tool call with a link, the builder lines (no duplicates from the ACP side).
    const kinds = gen.state.activity.map((a) => `${a.kind}:${a.kind === "builder" ? a.title : ""}`);
    expect(kinds.filter((k) => k.startsWith("tool:"))).toHaveLength(2);
    expect(gen.state.activity.find((a) => a.kind === "message")?.title).toBe("Reading the change first.");
    expect(gen.state.activity.find((a) => a.kind === "tool")?.locations).toEqual([{ path: "src/deliver.ts", line: 2 }]);
    expect(gen.state.activity.find((a) => a.kind === "permission")?.detail).toBe("Allow once");
    const refused = gen.state.activity.find((a) => a.kind === "builder" && a.isError);
    expect(refused?.detail).toBe("src/deliver.test.ts → 1: `src/deliver.test.ts` is already in chapter 2 (c2). Use guide_move_file to move it.");

    // Saved where the web app finds it, with the VS Code sidecar beside it; the draft is gone.
    const saved = loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!);
    expect(saved?.envelope.guide.sections.map((s) => s.diffs.map((d) => d.file))).toEqual([["src/retryPolicy.ts"], ["src/deliver.test.ts", "src/deliver.ts"]]);
    expect((saved?.envelope.guide as { overview?: { text: string } }).overview?.text).toContain("symbol:computeBackoff");
    expect(saved?.envelope.review?.source).toEqual({ kind: "local", repo: "checkout-service", branch: "feat/retries", headSha: w.input.source.headSha });
    expect(saved?.envelope.customInstructions).toBe("Keep chapters short.");
    expect(saved?.envelope.model).toBe("sonnet");
    expect(saved?.rawPatch).toBe(w.input.rawPatch);
    expect(saved?.sidecar.focus).toEqual({ "src/retryPolicy.ts": [{ start: 1, end: 3 }] });
    expect(saved?.sidecar.cost).toEqual({ amount: 0.17, currency: "USD" });
    expect(listDraftRecords(w.input.repoKey)).toEqual([]);
    expect(listRecent(w.input.repoKey).map((r) => r.kind)).toEqual(["guide"]);
  });

  it("keeps the draft when the agent crashes, and Resume finishes it under the same id", async () => {
    const w = world([header, ch1, place("src/retryPolicy.ts", "c1"), { exit: 3 }]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toStartWith("The agent exited with code 3.");
    const record = loadDraftRecord(w.input.repoKey, gen.state.id);
    expect(record?.status).toBe("failed");
    expect(record?.draft.chapters[0].files.map((f) => f.file)).toEqual(["src/retryPolicy.ts"]);
    const recent = listRecent(w.input.repoKey);
    expect(recent[0]).toMatchObject({ kind: "draft", draftInfo: { chapters: 1, filesLeft: 2, status: "failed" } });

    const w2 = world([{ mcp: { name: "guide_read" } }, ch2, place("src/deliver.ts", "c2"), place("src/deliver.test.ts", "c2"), { mcp: { name: "guide_finish" } }], { resume: record! });
    w2.input.repoKey = w.input.repoKey;
    w2.input.source = w.input.source;
    w2.input.rawPatch = w.input.rawPatch;
    w2.input.files = w.input.files;
    const resumed = new GuideGeneration(w2.input, w2.deps);
    expect(resumed.state.id).toBe(gen.state.id);
    await resumed.run();
    expect(resumed.state.status).toBe("finished");
    const prompt = w2.log().find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain("A draft of this guide already exists.");
    expect(w2.log().find((e) => e.event === "mcpCall")?.text).toContain("1. c1 · The retry budget");
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)).toBeNull();
  });

  it("cancels: session/cancel reaches the agent and the draft is kept as stopped", async () => {
    const w = world([header, ch1, { sleep: 3000 }, ch2], { pace: 10 });
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    await new Promise<void>((resolve) => {
      const off = gen.onChange((s) => {
        if (s.draft.chapters.length === 1) {
          off();
          resolve();
        }
      });
    });
    await gen.cancel();
    await running;
    expect(gen.state.status).toBe("stopped");
    expect(gen.state.statusMessage).toBe("Cancelled.");
    expect(w.log().some((e) => e.event === "cancel")).toBe(true);
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)?.status).toBe("stopped");

    // Save as is: the leftovers go to "Not in a chapter", the empty chapter is dropped.
    const placed = world([]);
    void placed;
    const result = await gen.saveAsIs();
    expect(result.ok).toBe(false); // the only chapter has no files
  });

  it("passes a rejected permission back to the agent", async () => {
    const w = world([{ permission: { title: "Run rm -rf build" } }, header], { choose: "reject-once" });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(w.log().find((e) => e.event === "permission")?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(gen.state.activity.find((a) => a.kind === "permission")?.status).toBe("failed");
    expect(gen.state.status).toBe("stopped");
    expect(gen.state.statusMessage).toContain("without calling guide_finish");
  });

  it("saves a stopped draft as is", async () => {
    const w = world([header, ch1, ch2, place("src/retryPolicy.ts", "c1")]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("stopped");
    const result = await gen.saveAsIs();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = loadSavedGuide(w.input.repoKey, result.guideId)!;
    expect(saved.envelope.guide.sections.map((s) => s.title)).toEqual(["The retry budget"]);
    expect(saved.envelope.guide.unplacedFiles?.sort()).toEqual(["src/deliver.test.ts", "src/deliver.ts"]);
    expect(gen.state.status).toBe("finished");
  });

  it("never loads a pull request's own Claude Code settings or MCP config: settingSources user only, strict MCP", async () => {
    const w = world([header]);
    w.input.source = { ...w.input.source, kind: "pr", label: "PR #482", pr: { number: 482, url: "https://github.com/northwind/checkout-service/pull/482", title: "Retry" }, worktreePath: w.input.source.headRoot };
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    const newSession = w.log().find((e) => e.event === "newSession")!;
    expect(newSession.meta).toEqual({ claudeCode: { options: { settingSources: ["user"], strictMcpConfig: true, allowDangerouslySkipPermissions: false } } });
    // Our builder server is still the one MCP server the agent gets.
    expect(newSession.mcpServers).toEqual([{ name: "plannotator-guide" }]);
  });

  const asPullRequest = (w: World) => {
    w.input.source = { ...w.input.source, kind: "pr", label: "PR #482", pr: { number: 482, url: "https://github.com/northwind/checkout-service/pull/482", title: "Retry" }, worktreePath: w.input.source.headRoot };
  };
  /** The log index of the first prompt, and of every mode change before it. */
  const modeChangesBeforePrompt = (log: Array<Record<string, any>>) => {
    const promptAt = log.findIndex((e) => e.event === "prompt");
    return log.slice(0, promptAt < 0 ? log.length : promptAt).filter((e) => e.event === "setMode" || (e.event === "setConfig" && e.configId === "mode"));
  };

  for (const startMode of ["bypassPermissions", "acceptEdits"]) {
    it(`sets a pull request run that starts in ${startMode} back to default before the first prompt (mode config option)`, async () => {
      const w = world([header], { script: { startMode } });
      asPullRequest(w);
      const gen = new GuideGeneration(w.input, w.deps);
      await gen.run();
      const log = w.log();
      expect(modeChangesBeforePrompt(log)).toEqual([{ event: "setConfig", configId: "mode", value: "default" }]);
      const prompt = log.find((e) => e.event === "prompt")!;
      expect(prompt.mode).toBe("default");
      expect(gen.state.activity.some((a) => a.title.includes(`started in ${startMode}`))).toBe(true);
    });
  }

  it("uses session/set_mode for an adapter that exposes modes but no mode config option", async () => {
    const w = world([header], { script: { startMode: "bypassPermissions", modeSurface: "modes" } });
    asPullRequest(w);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    const log = w.log();
    expect(modeChangesBeforePrompt(log)).toEqual([{ event: "setMode", modeId: "default" }]);
    expect(log.find((e) => e.event === "prompt")!.mode).toBe("default");
  });

  it("aborts a pull request run whose mode cannot be set back: no prompt is sent", async () => {
    for (const script of [
      { startMode: "bypassPermissions", refuseModeChange: true },
      { startMode: "acceptEdits", ignoreModeChange: true },
      { startMode: "bypassPermissions", modeSurface: "modes", refuseModeChange: true },
    ]) {
      const w = world([header], { script });
      asPullRequest(w);
      const gen = new GuideGeneration(w.input, w.deps);
      await gen.run();
      expect(gen.state.status).toBe("failed");
      expect(gen.state.statusMessage).toStartWith(`This pull request's settings ask for ${script.startMode}; Guides runs PRs only in the default permission mode.`);
      expect(w.log().some((e) => e.event === "prompt")).toBe(false);
      expect(gen.state.activity.at(-1)?.isError).toBe(true);
    }
  });

  it("leaves a local-changes run in the mode it started in", async () => {
    const w = world([header], { script: { startMode: "acceptEdits" } });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    const log = w.log();
    expect(modeChangesBeforePrompt(log)).toEqual([]);
    expect(log.find((e) => e.event === "prompt")!.mode).toBe("acceptEdits");
  });

  it("leaves a pull request run that already starts in default alone", async () => {
    const w = world([header], { script: { startMode: "default" } });
    asPullRequest(w);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(modeChangesBeforePrompt(w.log())).toEqual([]);
    expect(w.log().find((e) => e.event === "prompt")!.mode).toBe("default");
  });

  it("fails a signed-out run with the agent's own sign-in commands", async () => {
    const w = world([header, { authRequired: true }]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toStartWith("Claude Code is not signed in.");
    expect(gen.state.signIn?.logins).toEqual([{ label: "Claude Subscription", args: ["--cli", "auth", "login", "--claudeai"] }]);
    expect(loadDraftRecord(w.input.repoKey, gen.state.id)?.status).toBe("failed");
  });

  it("refuses an agent that speaks another ACP protocol version", async () => {
    const w = world([header], { script: { protocolVersion: 2 } });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("failed");
    expect(gen.state.statusMessage).toContain("ACP protocol version 2");
    expect(w.log().some((e) => e.event === "newSession")).toBe(false);
  });

  it("kills what the agent started when the run ends, even after the agent itself exited", async () => {
    const w = world([{ spawnStubborn: true }, header]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    const pid = w.log().find((e) => e.event === "stubborn")?.pid as number;
    expect(typeof pid).toBe("number");
    expect(await gone(pid, 6000)).toBe(true);
  });

  it("kill() stops the agent and everything it started at once (VS Code closing)", async () => {
    const w = world([{ spawnStubborn: true }, header, { sleep: 20000 }]);
    const gen = new GuideGeneration(w.input, w.deps);
    const running = gen.run();
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = w.log().find((e) => e.event === "stubborn")?.pid;
    }
    expect(pid).toBeDefined();
    gen.kill();
    expect(await gone(pid!, 1500)).toBe(true);
    await running;
  });

  it("with guide history off, writes no draft and no guide: the guide is kept in memory", async () => {
    const w = world([header, ch1, ch2, place("src/retryPolicy.ts", "c1"), place("src/deliver.ts", "c2"), place("src/deliver.test.ts", "c2"), { mcp: { name: "guide_finish" } }]);
    w.deps.history = false;
    const seenDrafts: number[] = [];
    const gen = new GuideGeneration(w.input, w.deps);
    gen.onChange(() => seenDrafts.push(listDraftRecords(w.input.repoKey).length));
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(gen.state.memoryOnly).toBe(true);
    expect(gen.state.statusMessage).toContain("Not saved: guide history is off");
    expect(seenDrafts.every((n) => n === 0)).toBe(true);
    expect(listRecent(w.input.repoKey)).toEqual([]);
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)).toBeNull();
    expect(gen.memoryGuide?.id).toBe(gen.state.savedGuideId);
    expect(gen.memoryGuide?.envelope.title).toBe("Retry failed webhook deliveries");
    expect(gen.memoryGuide?.rawPatch).toBe(w.input.rawPatch);
    expect(gen.toDraftRecord().draft.chapters).toHaveLength(2);
  });

  it("says so when the overview diagram could not be render-checked, and records it for the reader", async () => {
    const w = world([
      header,
      ch1,
      place("src/retryPolicy.ts", "c1"),
      place("src/deliver.ts", "c1"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start here.", diagram: { kind: "mermaid", source: "flowchart LR\n a-->b" } } } },
      { mcp: { name: "guide_finish" } },
    ]);
    w.deps.checkMermaid = async () => ({ ok: true, checked: false });
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.status).toBe("finished");
    expect(gen.state.diagramUnchecked).toBe(true);
    expect(gen.state.statusMessage).toContain("not render-checked");
    expect(w.log().filter((e) => e.event === "mcpCall" && e.name === "guide_finish")[0].text).toContain("could not be render-checked");
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)?.sidecar.diagramCheck).toBe("unchecked");
  });

  it("records a checked diagram as ok", async () => {
    const w = world([
      header,
      ch1,
      place("src/retryPolicy.ts", "c1"),
      place("src/deliver.ts", "c1"),
      place("src/deliver.test.ts", "c1"),
      { mcp: { name: "guide_set_overview", args: { text: "Start here.", diagram: { kind: "mermaid", source: "flowchart LR\n a-->b" } } } },
      { mcp: { name: "guide_finish" } },
    ]);
    const gen = new GuideGeneration(w.input, w.deps);
    await gen.run();
    expect(gen.state.diagramUnchecked).toBeUndefined();
    expect(loadSavedGuide(w.input.repoKey, gen.state.savedGuideId!)?.sidecar.diagramCheck).toBe("ok");
  });
});

/** Wait until a process no longer exists. */
async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
    return false;
  } catch {
    return true;
  }
}
