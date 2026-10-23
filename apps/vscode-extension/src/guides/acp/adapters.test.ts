import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../sources/runner";
import { adaptersRoot, hasManagedCopy, installAdapter, managedDir, managedLaunch, manualInstallCommand, npmCommand, npmReason } from "./adapters";
import { ensureAgentLaunch } from "./ensure-launch";
import { CLAUDE_CODE, CODEX, COPILOT, CURSOR, KILO, KIRO, KNOWN_AGENTS, OPENCODE, PI, canStart, detectAgents, resolveAgentLaunch, type AgentDescriptor } from "./agents";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "pn-adapters-"));
  dirs.push(d);
  return adaptersRoot(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FOUND = (names: string[]) => (name: string) => (names.includes(name) ? `/bin/${name}` : null);

/** A scripted npm: records every call and, when `ok`, writes the package the way npm would. */
function fakeNpm(opts: { ok?: boolean; stderr?: string; nodeVersion?: string; engines?: string } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: Runner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "--version") return { code: 0, stdout: opts.nodeVersion ?? "v22.4.0\n", stderr: "" };
    if (opts.ok === false) return { code: 1, stdout: "", stderr: opts.stderr ?? "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope\nnpm error A complete log of this run can be found in: /x" };
    const prefix = args[args.indexOf("--prefix") + 1];
    const spec = args[args.length - 1];
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const pkgDir = join(prefix, "node_modules", ...name.split("/"));
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const bin = name.split("/").pop()!;
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version, bin: { [bin]: "dist/index.js" }, ...(opts.engines && { engines: { node: opts.engines } }) }));
    writeFileSync(join(pkgDir, "dist", "index.js"), "#!/usr/bin/env node\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("which agents have an npm adapter Guided Reviews installs", () => {
  it("pins Claude Code, Codex and Pi to exact versions, and never the agents that are their own program", () => {
    expect(CLAUDE_CODE.adapter).toEqual({ package: "@agentclientprotocol/claude-agent-acp", version: "0.91.0", bin: "claude-agent-acp" });
    expect(CODEX.adapter).toEqual({ package: "@agentclientprotocol/codex-acp", version: "2.2.2", bin: "codex-acp" });
    expect(PI.adapter).toEqual({ package: "pi-acp", version: "0.0.34", bin: "pi-acp" });
    for (const a of [OPENCODE, COPILOT, CURSOR, KIRO, KILO]) expect(a.adapter).toBeUndefined();
    for (const a of KNOWN_AGENTS) {
      if (!a.adapter) continue;
      expect(a.adapter.version).toMatch(/^\d+\.\d+\.\d+$/);
      // The manual command a person is shown is the same pinned version.
      expect(a.installCommand).toBe(manualInstallCommand(a.adapter));
    }
  });
});

describe("resolution order: setting, PATH, the installed copy, then install now", () => {
  const managedHere = (root: string) => (a: AgentDescriptor) => (a.adapter ? managedLaunch(root, a.id, a.adapter, a.args, { findNode: () => "/bin/node" }) : null);

  it("prefers the setting, then PATH, then the copy Guided Reviews installed", async () => {
    const root = tempRoot();
    const { runner } = fakeNpm();
    expect((await installAdapter(root, "claude-code", "Claude Code", CLAUDE_CODE.adapter!, { runner, findExecutable: FOUND(["npm", "node"]) })).ok).toBe(true);
    const managed = managedHere(root);
    expect(resolveAgentLaunch(CLAUDE_CODE, { command: "mine" }, FOUND(["mine", "claude-agent-acp"]), managed)).toMatchObject({ ok: true, command: "/bin/mine", source: "setting" });
    expect(resolveAgentLaunch(CLAUDE_CODE, {}, FOUND(["claude-agent-acp"]), managed)).toMatchObject({ ok: true, command: "/bin/claude-agent-acp", source: "path" });
    const entry = join(managedDir(root, "claude-code"), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
    expect(resolveAgentLaunch(CLAUDE_CODE, {}, FOUND([]), managed)).toEqual({ ok: true, command: "/bin/node", args: [entry], source: "managed" });
  });

  it("says the adapter can be installed now when none is there, and a missing agent CLI needs the user", () => {
    const none = () => null;
    const r = resolveAgentLaunch(CODEX, {}, FOUND([]), none);
    expect(r).toMatchObject({ ok: false, reason: "adapter" });
    expect(!r.ok && r.message).toContain("@agentclientprotocol/codex-acp@2.2.2");
    expect(resolveAgentLaunch(OPENCODE, {}, FOUND([]), none)).toMatchObject({ ok: false, reason: "agent" });
    // A command in settings that is missing is never papered over with an install.
    expect(resolveAgentLaunch(CODEX, { command: "gone" }, FOUND([]), none)).toMatchObject({ ok: false, reason: "setting" });
  });

  it("asks for Pi itself before its adapter: pi-acp runs the pi program", () => {
    expect(resolveAgentLaunch(PI, {}, FOUND(["pi-acp"]), () => null)).toMatchObject({ ok: false, reason: "requires" });
    expect(resolveAgentLaunch(PI, {}, FOUND(["pi"]), () => null)).toMatchObject({ ok: false, reason: "adapter" });
  });

  it("lists an agent whose adapter it installs as ready only while installAdapters is on", () => {
    const ids = (on: boolean) => detectAgents(() => ({}), null, FOUND(["opencode"]), () => null, on).filter((s) => canStart(s.launch, on)).map((s) => s.agent.id);
    expect(ids(true)).toEqual(["claude-code", "codex", "opencode"]);
    expect(ids(false)).toEqual(["opencode"]);
  });

  it("reinstalls when the pinned version changed (an older copy is not used)", async () => {
    const root = tempRoot();
    const { runner } = fakeNpm();
    const old = { ...CODEX.adapter!, version: "2.1.1" };
    await installAdapter(root, "codex", "Codex", old, { runner, findExecutable: FOUND(["npm", "node"]) });
    expect(hasManagedCopy(root, "codex")).toBe(true);
    expect(managedLaunch(root, "codex", CODEX.adapter!, [], { findNode: () => "/bin/node" })).toBeNull();
    expect(resolveAgentLaunch(CODEX, {}, FOUND([]), (a) => managedLaunch(root, a.id, a.adapter!, a.args))).toMatchObject({ ok: false, reason: "adapter" });
  });
});

describe("installing an adapter", () => {
  it("runs npm install with the pinned version into the extension's storage, scripts off, nothing global", async () => {
    const root = tempRoot();
    const { runner, calls } = fakeNpm();
    const result = await installAdapter(root, "claude-code", "Claude Code", CLAUDE_CODE.adapter!, { runner, findExecutable: FOUND(["npm", "node"]), stamp: "t" });
    expect(result).toEqual({ ok: true, dir: managedDir(root, "claude-code") });
    const install = calls.find((c) => c.args.includes("install"))!;
    expect(install.command).toBe("/bin/npm");
    expect(install.args).toEqual([
      "install", "--prefix", `${managedDir(root, "claude-code")}.installing-t`, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error",
      "@agentclientprotocol/claude-agent-acp@0.91.0",
    ]);
    expect(install.args).not.toContain("-g");
    expect(install.args).not.toContain("--global");
    expect(calls.some((c) => /npx/.test(c.command))).toBe(false);
    expect(existsSync(`${managedDir(root, "claude-code")}.installing-t`)).toBe(false);
    expect(JSON.parse(readFileSync(join(managedDir(root, "claude-code"), "plannotator-adapter.json"), "utf8"))).toEqual({ package: "@agentclientprotocol/claude-agent-acp", version: "0.91.0", runtime: "node" });
  });

  it("runs the adapter with VS Code's own runtime when the node on PATH is older than the package needs", async () => {
    const root = tempRoot();
    const { runner } = fakeNpm({ nodeVersion: "v20.11.0", engines: ">=22" });
    await installAdapter(root, "claude-code", "Claude Code", CLAUDE_CODE.adapter!, { runner, findExecutable: FOUND(["npm", "node"]) });
    const launch = managedLaunch(root, "claude-code", CLAUDE_CODE.adapter!, [], { findNode: () => "/bin/node", execPath: "/vscode/Code Helper" });
    expect(launch).toMatchObject({ command: "/vscode/Code Helper", env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  it("fails with one line: the reason and the manual command, and keeps the copy it had", async () => {
    const root = tempRoot();
    await installAdapter(root, "codex", "Codex", CODEX.adapter!, { runner: fakeNpm().runner, findExecutable: FOUND(["npm", "node"]) });
    const result = await installAdapter(root, "codex", "Codex", CODEX.adapter!, { runner: fakeNpm({ ok: false }).runner, findExecutable: FOUND(["npm", "node"]) });
    expect(result).toEqual({ ok: false, message: "Could not install Codex's ACP adapter: E404: 404 Not Found - GET https://registry.npmjs.org/nope. Or run `npm install -g @agentclientprotocol/codex-acp@2.2.2` yourself." });
    expect(!result.ok && result.message.includes("\n")).toBe(false);
    expect(managedLaunch(root, "codex", CODEX.adapter!, [], { findNode: () => "/bin/node" })).not.toBeNull();
  });

  it("says npm is missing without running anything", async () => {
    const { runner, calls } = fakeNpm();
    const result = await installAdapter(tempRoot(), "pi", "Pi", PI.adapter!, { runner, findExecutable: FOUND([]) });
    expect(result).toEqual({ ok: false, message: "Could not install Pi's ACP adapter: npm is not on PATH (install Node.js from nodejs.org). Or run `npm install -g pi-acp@0.0.34` yourself." });
    expect(calls).toEqual([]);
  });

  it("runs npm-cli.js with node on Windows, where npm.cmd cannot be spawned without a shell", () => {
    expect(npmCommand(FOUND(["npm"]), "darwin")).toEqual({ command: "/bin/npm", args: [] });
    expect(npmCommand(() => null, "win32")).toBeNull();
  });

  it("reads npm's reason from its output", () => {
    expect(npmReason("npm error code EACCES\nnpm error syscall mkdir\n")).toBe("EACCES: syscall mkdir");
    expect(npmReason("")).toBe("");
  });
});

describe("getting an agent ready before a run", () => {
  const ok = { ok: true as const, command: "/x/node", args: ["entry.js"], source: "managed" as const };
  const missingAdapter = resolveAgentLaunch(CLAUDE_CODE, {}, FOUND([]), () => null);

  it("installs the missing adapter, then continues with the installed copy", async () => {
    let installed = false;
    const installs: string[] = [];
    const r = await ensureAgentLaunch(CLAUDE_CODE, {
      resolve: () => (installed ? ok : missingAdapter),
      installAdapters: true,
      install: async (a) => { installs.push(a.id); installed = true; return { ok: true, dir: "/d" }; },
      installFailed: async () => "stop",
      missing: async () => null,
    });
    expect(r).toEqual(ok);
    expect(installs).toEqual(["claude-code"]);
  });

  it("shows the failure with Retry, and installs again when asked", async () => {
    const failures: string[] = [];
    let tries = 0;
    const r = await ensureAgentLaunch(CODEX, {
      resolve: () => (tries >= 2 ? ok : missingAdapter),
      installAdapters: true,
      install: async () => (++tries < 2 ? { ok: false, message: "Could not install Codex's ACP adapter: E404. Or run `x` yourself." } : { ok: true, dir: "/d" }),
      installFailed: async (_a, message) => { failures.push(message); return "retry"; },
      missing: async () => null,
    });
    expect(failures).toEqual(["Could not install Codex's ACP adapter: E404. Or run `x` yourself."]);
    expect(tries).toBe(2);
    expect(r).toEqual(ok);
  });

  it("stops when the user does not retry", async () => {
    const r = await ensureAgentLaunch(CODEX, {
      resolve: () => missingAdapter,
      installAdapters: true,
      install: async () => ({ ok: false, message: "no" }),
      installFailed: async () => "stop",
      missing: async () => { throw new Error("not reached"); },
    });
    expect(r).toBeNull();
  });

  it("never installs with the setting off: it shows how to install instead", async () => {
    const shown: string[] = [];
    const r = await ensureAgentLaunch(CLAUDE_CODE, {
      resolve: () => missingAdapter,
      installAdapters: false,
      install: async () => { throw new Error("must not install"); },
      installFailed: async () => "stop",
      missing: async (_a, launch) => { shown.push(launch.reason); return null; },
    });
    expect(r).toBeNull();
    expect(shown).toEqual(["adapter"]);
  });

  it("never installs an agent that is its own program", async () => {
    const shown: string[] = [];
    await ensureAgentLaunch(OPENCODE, {
      resolve: (a) => resolveAgentLaunch(a, {}, FOUND([]), () => null),
      installAdapters: true,
      install: async () => { throw new Error("must not install"); },
      installFailed: async () => "stop",
      missing: async (_a, launch) => { shown.push(launch.reason); return null; },
    });
    expect(shown).toEqual(["agent"]);
  });

  it("does not loop when an install succeeds but the copy cannot be found", async () => {
    let installs = 0;
    const shown: string[] = [];
    const r = await ensureAgentLaunch(PI, {
      resolve: () => resolveAgentLaunch(PI, {}, FOUND(["pi"]), () => null),
      installAdapters: true,
      install: async () => { installs++; return { ok: true, dir: "/d" }; },
      installFailed: async () => "retry",
      missing: async (_a, launch) => { shown.push(launch.message); return null; },
    });
    expect(r).toBeNull();
    expect(installs).toBe(1);
    expect(shown[0]).toContain("was installed but could not be started");
  });
});
