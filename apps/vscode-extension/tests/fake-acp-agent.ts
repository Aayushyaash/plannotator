/**
 * A FAKE ACP agent for tests and screenshots. Never a real agent: it reads a
 * script (FAKE_ACP_SCRIPT, a JSON file) and plays it. It speaks ACP v1 on
 * stdio through the SDK's agent side, starts the stdio MCP servers the client
 * hands it in `session/new` (the builder relay), and calls their tools like a
 * real agent would. Everything it receives is appended to FAKE_ACP_LOG.
 *
 * Run with bun: `bun tests/fake-acp-agent.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";

type Step =
  | { say: string }
  | { tool: { title: string; kind?: string; locations?: Array<{ path: string; line?: number }>; fail?: boolean } }
  | { permission: { title: string } }
  | { mcp: { name: string; args?: Record<string, unknown> } }
  | { usage: { cost: number } }
  | { plan: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { sleep: number }
  | { exit: number }
  /** Fail the turn with ACP's authRequired error, as the real adapter does when Claude Code is signed out. */
  | { authRequired: true }
  /** Start a grandchild that ignores SIGTERM and log its pid (process-tree cleanup). */
  | { spawnStubborn: true };

interface Script {
  models?: Array<{ value: string; name: string }>;
  efforts?: Array<{ value: string; name: string }>;
  /** Fail session/new with this message (e.g. an auth error). */
  newSessionError?: string;
  steps: Step[];
  /** Delay between steps, ms. */
  pace?: number;
  /** Answer `initialize` with this protocol version instead of ours. */
  protocolVersion?: number;
  /**
   * Start the session in this permission mode, as the real adapter does from
   * the cwd's `.claude/settings*.json` `permissions.defaultMode`. Unset: the
   * fake advertises no modes at all.
   */
  startMode?: string;
  /** How the modes are advertised: a `mode` config option, `modes` on session/new, or both (the real adapter). */
  modeSurface?: "config" | "modes" | "both";
  /** Refuse every mode change (session/set_mode and the `mode` config option). */
  refuseModeChange?: boolean;
  /** Accept a mode change but stay in the start mode. */
  ignoreModeChange?: boolean;
}

const script: Script = JSON.parse(readFileSync(process.env.FAKE_ACP_SCRIPT ?? "", "utf8"));
const logPath = process.env.FAKE_ACP_LOG;
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

class McpClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  request(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method: string, params?: unknown) {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) })}\n`);
  }
  close() {
    this.child.stdin!.end();
    this.child.kill();
  }
}

const models = script.models ?? [
  { value: "default", name: "Default (Opus)" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku" },
];
const efforts = script.efforts ?? [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

let currentModel = models[0].value;
let currentEffort = efforts[efforts.length - 1].value;
let currentMode = script.startMode;
const modeSurface = script.modeSurface ?? "both";
const availableModes = [
  { id: "default", name: "Default" },
  { id: "acceptEdits", name: "Accept Edits" },
  { id: "plan", name: "Plan Mode" },
  { id: "bypassPermissions", name: "Bypass Permissions" },
];

function configOptions(): SessionConfigOption[] {
  return [
    ...(currentMode !== undefined && modeSurface !== "modes"
      ? [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: currentMode, options: availableModes.map((m) => ({ value: m.id, name: m.name })) }]
      : []),
    { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: models },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: currentEffort, options: efforts },
  ] as SessionConfigOption[];
}

function setMode(mode: string): void {
  if (script.refuseModeChange) throw new Error("Mode change refused");
  if (!script.ignoreModeChange) currentMode = mode;
}

const sessions = new Map<string, { cwd: string; mcp: McpClient | null; cancelled: boolean }>();

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

new AgentSideConnection((conn): Agent => ({
  async initialize(params) {
    log({ event: "initialize", clientCapabilities: params.clientCapabilities, clientInfo: params.clientInfo });
    // Like claude-agent-acp: terminal sign-ins only for a client that can run them.
    const authMethods = params.clientCapabilities?.auth?.terminal
      ? [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" as const, args: ["--cli", "auth", "login", "--claudeai"] }]
      : [];
    return { protocolVersion: (script.protocolVersion ?? PROTOCOL_VERSION) as typeof PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    log({ event: "newSession", cwd: params.cwd, mcpServers: params.mcpServers.map((s) => ({ name: s.name })), meta: params._meta ?? null });
    if (script.newSessionError) throw new Error(script.newSessionError);
    const sessionId = `fake-${Date.now()}`;
    let mcp: McpClient | null = null;
    const server = params.mcpServers[0] as { command?: string; args?: string[]; env?: Array<{ name: string; value: string }> } | undefined;
    if (server?.command) {
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const e of server.env ?? []) env[e.name] = e.value;
      const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
      mcp = new McpClient(child);
      const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } });
      mcp.notify("notifications/initialized");
      const list = await mcp.request("tools/list", {});
      log({ event: "mcpReady", protocolVersion: init.result?.protocolVersion, tools: (list.result?.tools ?? []).map((t: { name: string }) => t.name) });
    }
    sessions.set(sessionId, { cwd: params.cwd, mcp, cancelled: false });
    const modes = currentMode !== undefined && modeSurface !== "config" ? { currentModeId: currentMode, availableModes } : undefined;
    return { sessionId, configOptions: configOptions(), ...(modes && { modes }) };
  },
  async setSessionMode(params) {
    log({ event: "setMode", modeId: params.modeId });
    setMode(params.modeId);
    return {};
  },
  async setSessionConfigOption(params) {
    log({ event: "setConfig", configId: params.configId, value: params.value });
    if (params.configId === "mode") setMode(String(params.value));
    if (params.configId === "model") currentModel = String(params.value);
    if (params.configId === "effort") currentEffort = String(params.value);
    return { configOptions: configOptions() };
  },
  async prompt(params) {
    const session = sessions.get(params.sessionId)!;
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    log({ event: "prompt", text, model: currentModel, effort: currentEffort, mode: currentMode ?? null });
    const update = (u: Record<string, unknown>) => conn.sessionUpdate({ sessionId: params.sessionId, update: u as never });
    let toolNo = 0;
    for (const step of script.steps) {
      if (session.cancelled) break;
      if (script.pace) await sleep(script.pace);
      if ("say" in step) {
        for (const word of step.say.split(/(?<= )/)) await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
      } else if ("tool" in step) {
        const toolCallId = `t${++toolNo}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title: step.tool.title, kind: step.tool.kind ?? "read", status: "in_progress", locations: step.tool.locations?.map((l) => ({ path: l.path.startsWith("/") ? l.path : `${session.cwd}/${l.path}`, line: l.line })) });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: step.tool.fail ? "failed" : "completed" });
      } else if ("permission" in step) {
        const toolCallId = `t${++toolNo}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title: step.permission.title, kind: "execute", status: "pending" });
        const answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId, title: step.permission.title, kind: "execute", status: "pending" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        log({ event: "permission", outcome: answer.outcome });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: answer.outcome.outcome === "selected" && answer.outcome.optionId.startsWith("allow") ? "completed" : "failed" });
      } else if ("mcp" in step) {
        if (!session.mcp) throw new Error("no MCP server was given");
        const toolCallId = `t${++toolNo}`;
        // Like the real adapter: the builder call also shows as a tool call (the client folds it into the builder line).
        await update({ sessionUpdate: "tool_call", toolCallId, title: `mcp__plannotator-guide__${step.mcp.name}`, kind: "other", status: "in_progress" });
        const res = await session.mcp.request("tools/call", { name: step.mcp.name, arguments: step.mcp.args ?? {} });
        const answerText = res.result?.content?.[0]?.text ?? JSON.stringify(res.error);
        log({ event: "mcpCall", name: step.mcp.name, isError: res.result?.isError ?? true, text: answerText });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
      } else if ("usage" in step) {
        await update({ sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: step.usage.cost, currency: "USD" } });
      } else if ("plan" in step) {
        await update({ sessionUpdate: "plan", entries: step.plan.map((p) => ({ ...p, priority: "medium" })) });
      } else if ("sleep" in step) {
        await sleep(step.sleep);
      } else if ("exit" in step) {
        process.exit(step.exit);
      } else if ("authRequired" in step) {
        throw RequestError.authRequired(undefined, "Not logged in · Please run /login");
      } else if ("spawnStubborn" in step) {
        // Same process group as the agent (not detached), ignores SIGTERM like a stuck tool.
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        await sleep(200);
        log({ event: "stubborn", pid: child.pid });
      }
    }
    if (session.cancelled) {
      log({ event: "cancelled" });
      return { stopReason: "cancelled" };
    }
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    log({ event: "cancel" });
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  },
}), stream);

process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.mcp?.close();
  process.exit(0);
});
