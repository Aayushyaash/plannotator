import { describe, expect, it } from "bun:test";
import {
  CLAUDE_CODE,
  CODEX,
  COPILOT,
  CURSOR,
  KILO,
  KIRO,
  KNOWN_AGENTS,
  OPENCODE,
  PI,
  claudePrSettingsRisk,
  customAgent,
  openCodeConfig,
  detectAgents,
  engineLabel,
  findAgent,
  loginCommands,
  pickDefault,
  readAgentOptions,
  resolveAgentLaunch,
  sessionMetaFor,
  type AgentDescriptor,
} from "./agents";
import { planSpawn, shimEntry } from "./spawn-plan";

/** What `npm install -g` writes on Windows for a package bin. */
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*',
].join("\r\n");

describe("starting the adapter on Windows", () => {
  it("runs an npm .cmd shim's JavaScript entry with node, never through cmd.exe", () => {
    const plan = planSpawn("C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd", ["--x"], {
      platform: "win32",
      readShim: () => NPM_SHIM,
      findNode: () => "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(plan).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js", "--x"],
    });
  });

  it("falls back to VS Code's own runtime when no node is on PATH", () => {
    const plan = planSpawn("C:\\npm\\claude-agent-acp.cmd", [], { platform: "win32", readShim: () => NPM_SHIM, findNode: () => null, execPath: "C:\\VSCode\\Code.exe" });
    expect(plan).toEqual({ command: "C:\\VSCode\\Code.exe", args: ["C:\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  });

  it("refuses a .cmd it cannot read as an npm shim, and a shim pointing outside its folder", () => {
    expect(() => planSpawn("C:\\x\\tool.cmd", [], { platform: "win32", readShim: () => "@echo off\r\nnode %*\r\n", findNode: () => "node" })).toThrow("not an npm command shim");
    expect(shimEntry("C:\\npm\\a.cmd", '"%dp0%\\..\\..\\evil.js" %*')).toBeNull();
  });

  it("spawns everything else as it is", () => {
    expect(planSpawn("/usr/local/bin/claude-agent-acp", ["a"], { platform: "darwin" })).toEqual({ command: "/usr/local/bin/claude-agent-acp", args: ["a"] });
    expect(planSpawn("C:\\bin\\claude-agent-acp.exe", [], { platform: "win32" })).toEqual({ command: "C:\\bin\\claude-agent-acp.exe", args: [] });
  });
});

describe("agent session policy", () => {
  it("loads only the user's Claude Code settings, no project MCP config and no bypass for a pull request", () => {
    const tools = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "KillBash"];
    expect(sessionMetaFor(CLAUDE_CODE, { kind: "pr" })).toEqual({ claudeCode: { options: { settingSources: ["user"], strictMcpConfig: true, allowDangerouslySkipPermissions: false, disallowedTools: [...tools, "WebFetch", "WebSearch"] } } });
    expect(sessionMetaFor(CLAUDE_CODE, { kind: "local" })).toEqual({ claudeCode: { options: { strictMcpConfig: true, disallowedTools: tools } } });
    // Only Claude Code reads _meta.claudeCode.
    for (const a of KNOWN_AGENTS.filter((x) => x !== CLAUDE_CODE)) expect(sessionMetaFor(a, { kind: "pr" })).toBeUndefined();
  });

  it("reads the terminal sign-ins the agent offers", () => {
    expect(loginCommands([
      { id: "claude-ai-login", name: "Claude Subscription", description: "Use Claude subscription", type: "terminal", args: ["--cli", "auth", "login", "--claudeai"] },
      { id: "gateway", name: "Custom gateway" } as never,
      { id: "bad", name: "Bad", type: "terminal", args: [1] } as never,
    ])).toEqual([{ label: "Claude Subscription", description: "Use Claude subscription", args: ["--cli", "auth", "login", "--claudeai"] }]);
    expect(loginCommands(undefined)).toEqual([]);
  });
});

const FOUND = (names: string[]) => (name: string) => (names.includes(name) || name.startsWith("/") ? (name.startsWith("/") ? name : `/bin/${name}`) : null);

describe("the agent registry", () => {
  it("lists exactly the supported agents, each with an install command and an https source", () => {
    expect(KNOWN_AGENTS.map((a) => a.id)).toEqual(["claude-code", "codex", "opencode", "copilot", "cursor", "kiro", "kilo", "pi"]);
    for (const a of KNOWN_AGENTS) {
      expect(a.installCommand.length).toBeGreaterThan(0);
      expect(a.docsUrl).toStartWith("https://");
      expect(a.readOnly.summary.length).toBeGreaterThan(0);
      // Never an npx download: only programs the user installed.
      expect([a.command, ...a.args].join(" ")).not.toContain("npx");
    }
    expect(new Set(KNOWN_AGENTS.map((a) => a.id)).size).toBe(KNOWN_AGENTS.length);
    expect(new Set(KNOWN_AGENTS.map((a) => a.engine)).size).toBe(KNOWN_AGENTS.length);
  });

  it("starts each agent the way its docs say", () => {
    const launch = (a: AgentDescriptor) => [a.command, ...a.args].join(" ");
    expect(launch(CLAUDE_CODE)).toBe("claude-agent-acp");
    expect(launch(CODEX)).toBe("codex-acp");
    expect(launch(OPENCODE)).toBe("opencode acp");
    expect(launch(COPILOT)).toBe("copilot --acp --stdio");
    expect(launch(CURSOR)).toBe("cursor-agent acp");
    expect(CURSOR.altCommands).toEqual(["agent"]);
    expect(launch(KIRO)).toBe("kiro-cli acp");
    expect(launch(KILO)).toBe("kilo acp");
    expect(KILO.altCommands).toEqual(["kilocode"]);
    expect(launch(PI)).toBe("pi-acp");
  });

  it("says which agents enforce read-only themselves, and which only through the permission policy", () => {
    const layers = Object.fromEntries(KNOWN_AGENTS.map((a) => [a.id, a.readOnly.layer]));
    expect(layers).toEqual({ "claude-code": "agent", codex: "agent", opencode: "agent", copilot: "permissions", cursor: "agent", kiro: "permissions", kilo: "agent", pi: "permissions" });
    expect(CODEX.readOnly.mode?.ids).toEqual(["read-only"]);
    expect(OPENCODE.readOnly.mode?.ids).toEqual(["plannotator-guide-review"]);
    expect(CURSOR.readOnly.mode?.ids).toEqual(["ask", "plan"]);
    expect(KILO.readOnly.mode?.ids).toEqual(["ask"]);
    expect(JSON.parse(KILO.readOnly.env!.KILO_CONFIG_CONTENT)).toEqual({ permission: { webfetch: "deny", websearch: "deny" } });
  });

  it("takes pull requests only for Claude Code and OpenCode (fails closed for the rest)", () => {
    const prs = KNOWN_AGENTS.filter((a) => !a.refusePullRequests && !a.unsupported).map((a) => a.id);
    expect(prs).toEqual(["claude-code", "opencode"]);
    expect(customAgent({ command: "/opt/x" })?.refusePullRequests).toBeTruthy();
    expect(KILO.refusePullRequests).toContain("mcp.json");
  });

  it("gives OpenCode its own read-only agent, '*' first so every later rule is an exception", () => {
    for (const run of ["local", "pr"] as const) {
      const cfg = JSON.parse(openCodeConfig(run));
      expect(cfg.lsp).toBe(false);
      expect(Object.keys(cfg)).toEqual(["lsp", "agent"]);
      const agent = cfg.agent["plannotator-guide-review"];
      expect(agent.mode).toBe("primary");
      expect(Object.keys(agent.permission)[0]).toBe("*");
      expect(agent.permission["*"]).toBe("ask");
      for (const k of ["grep", "glob", "list", "todowrite", "plannotator-guide_*"]) expect(agent.permission[k]).toBe("allow");
      expect(agent.permission.read["*"]).toBe("allow");
      expect(agent.permission.read["*.env"]).toBe("ask");
      for (const k of ["edit", "bash", "task", "lsp", "question", "websearch", "codesearch"]) expect(agent.permission[k]).toBe("deny");
      expect(agent.permission.external_directory).toBe("ask");
      expect(agent.permission.webfetch).toBe(run === "pr" ? "deny" : "ask");
    }
    expect(OPENCODE.readOnly.env?.OPENCODE_CONFIG_CONTENT).toBe(openCodeConfig("local"));
    expect(OPENCODE.readOnly.prEnv?.OPENCODE_CONFIG_CONTENT).toBe(openCodeConfig("pr"));
  });

  it("refuses a Claude Code pull request whose own settings would start a program, and fails closed on an unreadable file", () => {
    const files = (map: Record<string, string>) => (path: string) => {
      const name = Object.keys(map).find((k) => path.endsWith(k));
      if (name === undefined) throw Object.assign(new Error("no"), { code: "ENOENT" });
      return map[name];
    };
    expect(claudePrSettingsRisk("/r", files({}))).toBeNull();
    expect(claudePrSettingsRisk("/r", files({ "settings.json": JSON.stringify({ permissions: { allow: ["Bash(*)"] }, hooks: {} }) }))).toBeNull();
    for (const key of ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "env"]) {
      expect(claudePrSettingsRisk("/r", files({ "settings.local.json": JSON.stringify({ [key]: "x" }) }))).toContain(`.claude/settings.local.json sets ${key}`);
    }
    expect(claudePrSettingsRisk("/r", files({ "settings.json": "{ // jsonc\n }" }))).toContain("is not plain JSON");
    expect(claudePrSettingsRisk("/r", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).toContain("could not be read");
  });

  it("refuses Codex for pull requests, and never starts Pi", () => {
    expect(CODEX.refusePullRequests).toContain(".codex/");
    expect(PI.unsupported).toContain("MCP");
    const r = resolveAgentLaunch(PI, {}, "local", FOUND(["pi-acp"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toStartWith("Pi: pi-acp does not pass MCP servers");
  });
});

describe("starting an agent", () => {
  it("finds the program on PATH and adds the read-only arguments and environment", () => {
    expect(resolveAgentLaunch(CODEX, {}, "local", FOUND(["codex-acp"]))).toEqual({ ok: true, command: "/bin/codex-acp", args: [], env: { INITIAL_AGENT_MODE: "read-only" }, source: "path" });
    expect(resolveAgentLaunch(CLAUDE_CODE, {}, "local", FOUND(["claude-agent-acp"]))).toEqual({ ok: true, command: "/bin/claude-agent-acp", args: [], source: "path" });
  });

  it("adds the pull-request environment only to a pull request run", () => {
    const local = resolveAgentLaunch(OPENCODE, {}, "local", FOUND(["opencode"]));
    const pr = resolveAgentLaunch(OPENCODE, {}, "pr", FOUND(["opencode"]));
    expect(local.ok && local.env).toEqual({ OPENCODE_CONFIG_CONTENT: openCodeConfig("local") });
    expect(pr.ok && pr.env).toEqual({ OPENCODE_CONFIG_CONTENT: openCodeConfig("pr"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" });
  });

  it("tries the program's other names", () => {
    expect(resolveAgentLaunch(CURSOR, {}, "local", FOUND(["agent"]))).toMatchObject({ ok: true, command: "/bin/agent", args: ["acp"] });
    expect(resolveAgentLaunch(KILO, {}, "local", FOUND(["kilocode"]))).toMatchObject({ ok: true, command: "/bin/kilocode", args: ["acp"] });
  });

  it("says how to install a missing agent", () => {
    const r = resolveAgentLaunch(OPENCODE, {}, "local", FOUND([]));
    expect(r).toEqual({ ok: false, message: "OpenCode is not installed: `opencode` is not on PATH. Install it with `curl -fsSL https://opencode.ai/install | bash`, then try again." });
  });

  it("uses a command override with its own args, or the agent's, and keeps the read-only additions", () => {
    expect(resolveAgentLaunch(OPENCODE, { command: "/opt/oc" }, "local", FOUND([]))).toMatchObject({ ok: true, command: "/opt/oc", args: ["acp"], source: "setting" });
    expect(resolveAgentLaunch(CODEX, { command: "/opt/codex-acp", args: ["--x"] }, "local", FOUND([]))).toMatchObject({ ok: true, command: "/opt/codex-acp", args: ["--x"], env: { INITIAL_AGENT_MODE: "read-only" } });
    expect(resolveAgentLaunch(CODEX, { command: "nope" }, "local", FOUND([]))).toEqual({ ok: false, message: "The configured command for Codex, `nope`, was not found." });
  });

  it("lists installed agents first, then the rest, and the custom agent when set", () => {
    const custom = customAgent({ command: "/opt/my-acp", args: ["acp"], label: "Mine" });
    const statuses = detectAgents(() => ({}), custom, FOUND(["opencode", "kiro-cli"]));
    expect(statuses.map((s) => [s.agent.id, s.launch.ok])).toEqual([
      ["opencode", true], ["kiro", true], ["custom", true],
      ["claude-code", false], ["codex", false], ["copilot", false], ["cursor", false], ["kilo", false], ["pi", false],
    ]);
    expect(custom?.readOnly.layer).toBe("permissions");
    expect(custom?.label).toBe("Mine");
    expect(customAgent({ command: "  " })).toBeNull();
    expect(findAgent("custom", custom)).toBe(custom);
    expect(findAgent("kilo", null)).toBe(KILO);
    expect(findAgent("gone", null)).toBeNull();
  });

  it("names a saved guide's engine", () => {
    expect(engineLabel("claude")).toBe("Claude Code");
    expect(engineLabel("kilo")).toBe("Kilo Code");
    expect(engineLabel("acp")).toBe("acp");
    expect(engineLabel(undefined)).toBe("");
  });
});

describe("cheap defaults", () => {
  const select = { configId: "model", name: "Model", current: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] };
  it("prefers the remembered choice, then the agent's cheap default, then its current one", () => {
    expect(pickDefault(select, /sonnet/i, "opus")?.value).toBe("opus");
    expect(pickDefault(select, /sonnet/i)?.value).toBe("sonnet");
    expect(pickDefault(select, undefined)?.value).toBe("opus");
    expect(pickDefault(null, /x/)).toBeNull();
  });

  it("reads model and effort from the agent's config options, whatever the effort is called", () => {
    const opts = (effort: Record<string, unknown>) => [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
      { name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }], ...effort },
    ] as never;
    for (const effort of [{ id: "e", category: "thought_level" }, { id: "thinking", category: "thinking" }, { id: "effortLevel" }, { id: "reasoning_effort", category: "other" }]) {
      const o = readAgentOptions("x", opts(effort), 1);
      expect(o.model?.current).toBe("a");
      expect(o.effort?.options.map((c) => c.value)).toEqual(["low"]);
    }
  });
});
