import { describe, expect, it } from "bun:test";
import { loginCommands, sessionMetaFor } from "./agents";
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
    expect(sessionMetaFor({ kind: "pr" })).toEqual({ claudeCode: { options: { settingSources: ["user"], strictMcpConfig: true, allowDangerouslySkipPermissions: false } } });
    expect(sessionMetaFor({ kind: "local" })).toBeUndefined();
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
