/**
 * The extension as an ACP v1 client (SPEC 4.1). It starts the agent as a
 * child process over stdio, with the user's own environment, and adds no
 * tools of its own beyond the builder's MCP server: no `fs/*`, no
 * `terminal/*` (the agent reads with its own tools). Permission requests go to
 * a callback that shows the agent's own options; this module never answers
 * one by itself, except "cancelled" for a request still open when the turn is
 * cancelled, which ACP requires.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type Client,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { augmentedPath } from "../sources/runner";

export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Added to the user's environment. */
  env?: Record<string, string>;
}

export interface AcpClientHandlers {
  onUpdate(notification: SessionNotification): void;
  /** Show the agent's options and return the user's choice. */
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  onStderr?(text: string): void;
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null }): void;
}

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

const STDERR_TAIL = 8 * 1024;

export class AcpClient {
  private readonly connection: ClientSideConnection;
  private readonly child: ChildProcess;
  private readonly pendingPermissions = new Set<AbortController>();
  private stderrTail = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exitWaiters: Array<() => void> = [];
  initializeResult: InitializeResponse | null = null;

  private constructor(child: ChildProcess, private readonly handlers: AcpClientHandlers) {
    this.child = child;
    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);
    const client: Client = {
      requestPermission: async (params) => {
        const controller = new AbortController();
        this.pendingPermissions.add(controller);
        try {
          const answer = await Promise.race([
            this.handlers.requestPermission(params, controller.signal),
            new Promise<RequestPermissionResponse>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true }),
            ),
          ]);
          return answer;
        } finally {
          this.pendingPermissions.delete(controller);
        }
      },
      sessionUpdate: async (params) => {
        this.handlers.onUpdate(params);
      },
    };
    this.connection = new ClientSideConnection((_agent: Agent) => client, stream);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      this.handlers.onStderr?.(text);
    });
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const c of this.pendingPermissions) c.abort();
      this.handlers.onExit?.({ code, signal });
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  /** Start the agent process and run `initialize`. */
  static async start(launch: AgentLaunch, handlers: AcpClientHandlers, clientInfo: AcpClientInfo): Promise<AcpClient> {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, PATH: augmentedPath(), ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so Cancel can stop everything the agent started.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const startError = await new Promise<Error | null>((resolve) => {
      child.once("error", (err) => resolve(err));
      child.once("spawn", () => resolve(null));
    });
    if (startError) throw new Error(`Could not start ${launch.command}: ${startError.message}`);
    const client = new AcpClient(child, handlers);
    try {
      client.initializeResult = await client.raceExit(
        client.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo,
        }),
        "initialize",
      );
    } catch (err) {
      client.dispose();
      throw err;
    }
    return client;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** Reject when the process exits before the request answers, with its stderr. */
  private raceExit<T>(promise: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onExit = () => {
        if (done) return;
        done = true;
        const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
        reject(new Error(`The agent exited during ${what}${this.exitInfo?.code != null ? ` (code ${this.exitInfo.code})` : ""}.${tail ? `\n${tail}` : ""}`));
      };
      if (this.exited) return onExit();
      this.exitWaiters.push(onExit);
      promise.then(
        (v) => {
          if (done) return;
          done = true;
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          reject(e);
        },
      );
    });
  }

  newSession(cwd: string, mcpServers: McpServer[]): Promise<NewSessionResponse> {
    return this.raceExit(this.connection.newSession({ cwd, mcpServers }), "session/new");
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const res = await this.raceExit(this.connection.setSessionConfigOption({ sessionId, configId, value }), "session/set_config_option");
    return res.configOptions;
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.raceExit(this.connection.prompt({ sessionId, prompt: [{ type: "text", text }] }), "session/prompt");
  }

  /** `session/cancel`; open permission prompts answer "cancelled". */
  async cancel(sessionId: string): Promise<void> {
    for (const c of this.pendingPermissions) c.abort();
    if (this.exited) return;
    try {
      await this.connection.cancel({ sessionId });
    } catch {
      // The process may be gone; dispose() handles the rest.
    }
  }

  /** Stop the agent and everything it started (its process group). */
  dispose(): void {
    for (const c of this.pendingPermissions) c.abort();
    if (this.exited || this.child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, "SIGTERM");
      else this.child.kill();
    } catch {
      this.child.kill();
    }
    const pid = this.child.pid;
    setTimeout(() => {
      if (this.exited) return;
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3000).unref?.();
  }

  /**
   * Plain words for a failed request: when the process ended (the connection
   * closes first, then the exit arrives), say so with its code and the end of
   * its stderr.
   */
  async describeFailure(err: unknown): Promise<string> {
    const message = err instanceof Error ? err.message : String(err);
    if (!this.exited && /connection closed|closed/i.test(message)) await this.waitForExit(1000);
    if (!this.exited) return message;
    const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
    const code = this.exitInfo?.code != null ? ` with code ${this.exitInfo.code}` : this.exitInfo?.signal ? ` (${this.exitInfo.signal})` : "";
    return `The agent exited${code}.${tail ? `\n${tail}` : ""}`;
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }
}

/** A select option flattened from `configOptions` (groups included). */
export interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigSelect {
  configId: string;
  name: string;
  current: string;
  options: ConfigChoice[];
}

/** The select option of a category (`model`, `thought_level`), or null when the agent exposes none. */
export function readConfigSelect(configOptions: readonly SessionConfigOption[] | null | undefined, category: string): ConfigSelect | null {
  for (const option of configOptions ?? []) {
    if (option.category !== category || option.type !== "select") continue;
    const raw = option.options as Array<{ value?: string; name: string; description?: string | null; options?: Array<{ value: string; name: string; description?: string | null }> }>;
    const flat: ConfigChoice[] = [];
    for (const entry of raw) {
      if (Array.isArray(entry.options)) {
        for (const o of entry.options) flat.push({ value: o.value, name: o.name, ...(o.description && { description: o.description }) });
      } else if (typeof entry.value === "string") {
        flat.push({ value: entry.value, name: entry.name, ...(entry.description && { description: entry.description }) });
      }
    }
    return { configId: option.id, name: option.name, current: String(option.currentValue), options: flat };
  }
  return null;
}
