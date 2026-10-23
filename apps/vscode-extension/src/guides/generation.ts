/**
 * One guide run: the agent over ACP, the builder draft behind the MCP relay,
 * and the state the generating view draws (SPEC 3.3, 4.1 to 4.4).
 *
 * No `vscode` here: the VS Code layer passes in how to ask for a permission,
 * how to resolve a symbol and how to render-check Mermaid, and draws `state`.
 * The draft is written to disk after every builder call, so a stopped run can
 * be resumed or saved as is; with guide history off (`PLANNOTATOR_GUIDE_HISTORY=0`
 * or `{ "guideHistory": false }`) nothing is written and the guide lives in
 * memory for this VS Code session only.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { McpServer, NewSessionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolCallLocation } from "@agentclientprotocol/sdk";
import {
  GUIDE_BUILDER_TOOLS,
  GUIDE_BUILDER_TOOL_NAMES,
  createGuideDraft,
  guideDraftProgress,
  guideSaveAsIs,
  runGuideBuilderTool,
  type GuideBuilderHooks,
  type GuideDraft,
  type GuideDraftProgress,
  type GuideFocusRange,
  type GuideSymbolResolution,
} from "./core/adapter";
import type { GuideLaunchReview, GuideSnapshot } from "@plannotator/core/guide-format";
import { ACP_AUTH_REQUIRED_CODE, AcpClient, readConfigSelect, type AcpClientInfo, type AgentLaunch } from "./acp/client";
import { loginCommands, sessionMetaFor, type LoginCommand } from "./acp/agents";
import type { RelayHost, RelaySession } from "./mcp/relay-host";
import type { ChangedFileInfo } from "./sources/git";
import { buildGuidePrompt } from "./prompt";
import {
  buildFinishedGuide,
  deleteDraftRecord,
  newDraftId,
  saveDraftRecord,
  saveFinishedGuide,
  type LoadedGuide,
  snapshotSource,
  sourceGitRef,
  type AgentChoiceRecord,
  type DraftRecord,
  type ReviewSourceRecord,
} from "./store";

export type GenerationStatus = "starting" | "running" | "finishing" | "finished" | "stopped" | "failed";

export interface ActivityEntry {
  id: number;
  /** Milliseconds since the run started. */
  at: number;
  kind: "message" | "tool" | "builder" | "plan" | "permission" | "info" | "error";
  title: string;
  detail?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** For tool calls: the files it touched, relative to the head root when inside it. */
  locations?: Array<{ path: string; line?: number }>;
  isError?: boolean;
}

export interface ChapterMark {
  /** Recently added chapters and the files that moved, for the draft panel's tags. */
  added: string[];
  moved: Record<string, number>;
}

export interface GenerationState {
  id: string;
  repoKey: string;
  status: GenerationStatus;
  statusMessage?: string;
  startedAt: number;
  endedAt?: number;
  source: ReviewSourceRecord;
  agent: AgentChoiceRecord;
  instructions?: string;
  cost?: { amount: number; currency: string };
  activity: ActivityEntry[];
  draft: GuideDraft;
  progress: GuideDraftProgress;
  marks: ChapterMark;
  savedGuideId?: string;
  acpSessionId?: string;
  /** Model and effort the agent reports after our choice was applied. */
  appliedModel?: string;
  appliedEffort?: string;
  /** The run failed because the agent is not signed in; these are its own login commands. */
  signIn?: { logins: LoginCommand[] };
  /** Guide history is off: nothing of this run is written to disk. */
  memoryOnly?: boolean;
  /** The overview diagram was saved without a render check (no Guides webview could run one). */
  diagramUnchecked?: boolean;
}

export interface GenerationDeps {
  relay: RelayHost;
  /** The agent adapter to start in `cwd`. */
  agentLaunch(cwd: string): AgentLaunch;
  /** How the agent starts the relay script (`dist/guide-mcp.cjs`); the session env is added. */
  mcpServer: { command: string; args: string[]; env?: Record<string, string> };
  clientInfo: AcpClientInfo;
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  resolveSymbol(name: string, path: string | undefined, files: readonly ChangedFileInfo[], headRoot: string): Promise<GuideSymbolResolution>;
  /** Render-check Mermaid with the Guide tab's engine; `checked: false` when no webview could do it. */
  checkMermaid(source: string): Promise<{ ok: true; checked: boolean } | { ok: false; message: string; line?: number }>;
  log?(line: string): void;
  now?(): number;
  /** Guide history (default on). Off: no draft or guide is written; the guide is kept in memory. */
  history?: boolean;
}

export interface GenerationInput {
  repoKey: string;
  source: ReviewSourceRecord;
  rawPatch: string;
  files: ChangedFileInfo[];
  agent: AgentChoiceRecord;
  instructions?: string;
  /** Continue a stopped draft: same id, its draft, a "continue" prompt. */
  resume?: DraftRecord;
}

const MAX_ACTIVITY = 400;
/** The only permission mode a pull request runs in. */
const DEFAULT_PERMISSION_MODE = "default";
const BUILDER_TITLE = /guide_(set_header|set_overview|add_chapter|update_chapter|move_chapter|remove_chapter|place_file|move_file|unplace_file|read|finish)(?![a-z_])/;

export class GuideGeneration {
  readonly state: GenerationState;
  private readonly listeners = new Set<(state: GenerationState) => void>();
  private client: AcpClient | null = null;
  private relaySession: RelaySession | null = null;
  private cancelled = false;
  private nextActivity = 1;
  private readonly toolEntries = new Map<string, ActivityEntry>();
  private messageEntry: ActivityEntry | null = null;
  private builderQueue: Promise<unknown> = Promise.resolve();
  private readonly hooks: GuideBuilderHooks;
  private readonly now: () => number;
  private readonly history: boolean;
  /** Render-check results per Mermaid source: "ok", or "unchecked" when no webview could run it. */
  private readonly diagramChecks = new Map<string, "ok" | "unchecked">();
  /** With history off, the finished guide (nothing on disk). */
  memoryGuide: LoadedGuide | null = null;

  constructor(
    private readonly input: GenerationInput,
    private readonly deps: GenerationDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.history = deps.history !== false;
    const draft = input.resume?.draft ?? createGuideDraft({
      review: launchReview(input),
      generator: {
        engine: "claude",
        ...(input.agent.model && { model: input.agent.model.id }),
        ...(input.instructions && { customInstructions: input.instructions }),
      },
      now: new Date(this.now()).toISOString(),
    });
    const id = input.resume?.id ?? newDraftId(this.now());
    this.hooks = this.makeHooks();
    this.state = {
      id,
      repoKey: input.repoKey,
      status: "starting",
      startedAt: this.now(),
      source: input.source,
      agent: input.agent,
      ...(input.instructions && { instructions: input.instructions }),
      ...(input.resume?.cost && { cost: input.resume.cost }),
      activity: [],
      draft,
      progress: guideDraftProgress(draft),
      marks: { added: [], moved: {} },
      ...(!this.history && { memoryOnly: true }),
    };
  }

  onChange(listener: (state: GenerationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.state.progress = guideDraftProgress(this.state.draft);
    for (const l of this.listeners) l(this.state);
  }

  private makeHooks(): GuideBuilderHooks {
    const { files, source } = this.input;
    const headRoot = source.headRoot;
    return {
      resolveFile: async ({ path }) => {
        const full = resolve(headRoot, path);
        const rel = relative(headRoot, full);
        if (rel.startsWith("..") || isAbsolute(rel)) return { exists: false };
        try {
          const text = await readFile(full, "utf8");
          return { exists: true, lineCount: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
        } catch {
          return { exists: false };
        }
      },
      resolveSymbol: ({ name, path }) => this.deps.resolveSymbol(name, path, files, headRoot),
      checkMermaid: async (src) => {
        const r = await this.deps.checkMermaid(src);
        if (r.ok) this.diagramChecks.set(src, r.checked ? "ok" : "unchecked");
        return r.ok ? { ok: true } : { ok: false, error: `${r.line ? `Line ${r.line}: ` : ""}${r.message}` };
      },
      now: () => new Date(this.now()).toISOString(),
    };
  }

  private addActivity(entry: Omit<ActivityEntry, "id" | "at">): ActivityEntry {
    const full: ActivityEntry = { id: this.nextActivity++, at: this.now() - this.state.startedAt, ...entry };
    this.state.activity.push(full);
    if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    return full;
  }

  /** The run as a draft record (what is written to disk after every builder call). */
  toDraftRecord(): DraftRecord {
    return {
      v: 1,
      id: this.state.id,
      repoKey: this.state.repoKey,
      createdAt: this.input.resume?.createdAt ?? this.state.startedAt,
      updatedAt: this.now(),
      status: this.state.status === "stopped" || this.state.status === "failed" ? this.state.status : "running",
      ...(this.state.statusMessage && { statusMessage: this.state.statusMessage }),
      source: this.state.source,
      agent: this.state.agent,
      ...(this.state.instructions && { instructions: this.state.instructions }),
      draft: this.state.draft,
      ...(this.state.acpSessionId && { acpSessionId: this.state.acpSessionId }),
      ...(this.state.cost && { cost: this.state.cost }),
    };
  }

  private persist(): void {
    if (this.state.status === "finished" || !this.history) return;
    const record = this.toDraftRecord();
    try {
      saveDraftRecord(record);
    } catch (err) {
      this.deps.log?.(`[guides] could not save the draft: ${err}`);
    }
  }

  /** Run the agent until it finishes, stops, fails or is cancelled. Never throws. */
  async run(): Promise<void> {
    const { source } = this.input;
    try {
      this.persist();
      this.relaySession = this.deps.relay.openSession({
        listTools: () => GUIDE_BUILDER_TOOLS,
        callTool: (name, args) => this.callBuilder(name, args),
      });
      const mcpServer: McpServer = {
        name: "plannotator-guide",
        command: this.deps.mcpServer.command,
        args: this.deps.mcpServer.args,
        env: Object.entries({ ...this.deps.mcpServer.env, ...this.relaySession.env }).map(([name, value]) => ({ name, value })),
      };
      this.addActivity({ kind: "info", title: `Starting ${this.input.agent.label}` });
      this.emit();
      this.client = await AcpClient.start(this.deps.agentLaunch(source.headRoot), {
        onUpdate: (n) => this.onUpdate(n),
        requestPermission: (req, signal) => this.onPermission(req, signal),
        onStderr: (text) => this.deps.log?.(`[agent] ${text.trimEnd()}`),
      }, this.deps.clientInfo);
      if (this.cancelled) return this.stop("Cancelled before the agent started.");
      const session = await this.client.newSession(source.headRoot, [mcpServer], sessionMetaFor(source));
      this.state.acpSessionId = session.sessionId;
      const configOptions = source.kind === "pr" ? await this.resetPermissionMode(session) : session.configOptions ?? [];
      if (this.cancelled) return this.stop("Cancelled.");
      await this.applyChoices(session.sessionId, configOptions);
      if (this.cancelled) return this.stop("Cancelled.");
      this.state.status = "running";
      this.persist();
      this.emit();
      const prompt = buildGuidePrompt({ source, files: this.input.files, instructions: this.input.instructions, resume: !!this.input.resume });
      const response = await this.client.prompt(session.sessionId, prompt);
      await this.builderQueue;
      if (this.state.savedGuideId) return this.finish();
      if (this.cancelled || response.stopReason === "cancelled") return this.stop("Cancelled.");
      const why = response.stopReason === "end_turn" ? "The agent ended its turn without calling guide_finish." : `The agent stopped (${response.stopReason}).`;
      return this.stop(why);
    } catch (err) {
      await this.builderQueue.catch(() => {});
      if (this.state.savedGuideId) return this.finish();
      if (this.cancelled) return this.stop("Cancelled.");
      const message = this.client ? await this.client.describeFailure(err) : err instanceof Error ? err.message : String(err);
      const needsSignIn = (err as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED_CODE || AUTH_TEXT.test(message);
      this.state.status = "failed";
      this.state.statusMessage = needsSignIn ? `${this.input.agent.label} is not signed in. Sign in, then resume the guide.\n${message}` : message;
      if (needsSignIn) this.state.signIn = { logins: loginCommands(this.client?.authMethods) };
      this.state.endedAt = this.now();
      this.addActivity({ kind: "error", title: "The run failed", detail: this.state.statusMessage, isError: true });
      this.persist();
      this.emit();
    } finally {
      this.relaySession?.dispose();
      this.relaySession = null;
      this.client?.dispose();
      this.client = null;
    }
  }

  /**
   * A pull request runs only in the default permission mode. The adapter reads
   * the worktree's `.claude/settings*.json` itself, whatever `settingSources`
   * says, and starts the session in its `permissions.defaultMode`: a PR could
   * ask for `bypassPermissions` (no prompts at all on older adapters) or
   * `acceptEdits`. Set it back to `default` before the first prompt; when that
   * fails, or the mode cannot be read while the adapter advertises modes, the
   * run is refused. Returns the session's config options after the change.
   */
  private async resetPermissionMode(session: NewSessionResponse): Promise<SessionConfigOption[]> {
    let options = session.configOptions ?? [];
    const select = readConfigSelect(options, "mode");
    const modes = session.modes ?? null;
    // An adapter that advertises no permission mode has none to set.
    if (!select && !modes) return options;
    const current = select ? select.current : modes?.currentModeId;
    if (current === DEFAULT_PERMISSION_MODE) return options;
    const refuse = (why: string): never => {
      const asked = current ? `ask for ${current}` : "ask for a permission mode Guides could not read";
      throw new Error(`This pull request's settings ${asked}; Guides runs PRs only in the default permission mode. ${why}`);
    };
    if (!current) refuse("The agent did not say which mode it started in.");
    let failure: string | null = null;
    try {
      if (select && select.options.some((o) => o.value === DEFAULT_PERMISSION_MODE)) {
        options = await this.client!.setConfigOption(session.sessionId, select.configId, DEFAULT_PERMISSION_MODE);
        const after = readConfigSelect(options, "mode");
        if (after?.current !== DEFAULT_PERMISSION_MODE) failure = `The agent stayed in ${after?.current ?? "a mode it did not report"}.`;
      } else if (modes?.availableModes.some((m) => m.id === DEFAULT_PERMISSION_MODE)) {
        await this.client!.setMode(session.sessionId, DEFAULT_PERMISSION_MODE);
      } else {
        failure = "The agent offers no default mode.";
      }
    } catch (err) {
      failure = `Setting it back failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (failure) refuse(failure);
    this.addActivity({ kind: "info", title: `The session started in ${current}; set back to the default permission mode for this pull request` });
    return options;
  }

  private async applyChoices(sessionId: string, configOptions: Parameters<typeof readConfigSelect>[0]): Promise<void> {
    let options = configOptions;
    const model = readConfigSelect(options, "model");
    const wantModel = this.input.agent.model?.id;
    if (model && wantModel && model.current !== wantModel) {
      if (model.options.some((o) => o.value === wantModel)) options = await this.client!.setConfigOption(sessionId, model.configId, wantModel);
      else this.addActivity({ kind: "info", title: `${this.input.agent.model?.label} is not offered; using the agent's default model` });
    }
    const effort = readConfigSelect(options, "thought_level");
    const wantEffort = this.input.agent.effort?.id;
    if (effort && wantEffort && effort.current !== wantEffort) {
      if (effort.options.some((o) => o.value === wantEffort)) options = await this.client!.setConfigOption(sessionId, effort.configId, wantEffort);
      else this.addActivity({ kind: "info", title: `Effort ${this.input.agent.effort?.label} is not offered for this model; using the agent's default` });
    }
    const m = readConfigSelect(options, "model");
    const e = readConfigSelect(options, "thought_level");
    if (m) this.state.appliedModel = m.options.find((o) => o.value === m.current)?.name ?? m.current;
    if (e) this.state.appliedEffort = e.options.find((o) => o.value === e.current)?.name ?? e.current;
  }

  private finish(): void {
    this.state.status = "finished";
    this.state.endedAt = this.now();
    const notes = [this.history ? "Saved." : "Done. Not saved: guide history is off, so this guide is kept only until VS Code closes."];
    if (this.state.diagramUnchecked) notes.push("The overview diagram was not render-checked (no Guides tab was open); it is checked when the guide opens.");
    this.state.statusMessage = notes.join(" ");
    if (this.history) deleteDraftRecord(this.input.repoKey, this.state.id);
    this.emit();
  }

  /** Stop the agent and everything it started at once (VS Code is closing). */
  kill(): void {
    this.cancelled = true;
    this.client?.kill();
    this.relaySession?.dispose();
  }

  private stop(message: string): void {
    this.state.status = "stopped";
    this.state.statusMessage = message;
    this.state.endedAt = this.now();
    this.addActivity({ kind: "info", title: message });
    this.persist();
    this.emit();
  }

  /** Cancel the run: `session/cancel`, then stop the agent if it does not end the turn. */
  async cancel(): Promise<void> {
    if (this.cancelled || this.state.status === "finished" || this.state.status === "stopped" || this.state.status === "failed") return;
    this.cancelled = true;
    const client = this.client;
    const sessionId = this.state.acpSessionId;
    if (client && sessionId) {
      await client.cancel(sessionId);
      const ended = await Promise.race([
        new Promise<boolean>((r) => {
          const off = this.onChange((s) => {
            if (s.status === "stopped" || s.status === "finished" || s.status === "failed") {
              off();
              r(true);
            }
          });
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (!ended) client.dispose();
    } else client?.dispose();
  }

  /** Save a stopped draft as it is (SPEC 4.4, "Nothing is lost"). */
  async saveAsIs(): Promise<{ ok: true; guideId: string } | { ok: false; problems: string[] }> {
    const answer = await guideSaveAsIs(this.state.draft, this.hooks);
    if (!answer.ok || !answer.snapshot) return { ok: false, problems: answer.text.split("\n").filter((l) => l.trim()) };
    const guideId = this.saveGuide(answer.snapshot, answer.draft);
    this.state.draft = answer.draft;
    this.state.savedGuideId = guideId;
    this.finish();
    return { ok: true, guideId };
  }

  private saveGuide(snapshot: GuideSnapshot, draft: GuideDraft): string {
    const diagram = (snapshot.guide as { overview?: { diagram?: { source?: string } } }).overview?.diagram?.source;
    const diagramCheck = diagram === undefined ? undefined : this.diagramChecks.get(diagram) ?? "unchecked";
    if (diagramCheck === "unchecked") this.state.diagramUnchecked = true;
    const input = {
      repoKey: this.input.repoKey,
      snapshot,
      source: this.input.source,
      agent: { ...this.input.agent },
      focus: focusMap(draft),
      ...(this.state.acpSessionId && { acpSessionId: this.state.acpSessionId }),
      ...(this.state.cost && { cost: this.state.cost }),
      ...(diagramCheck && { diagramCheck }),
      now: this.now(),
    };
    if (this.history) return saveFinishedGuide(input);
    this.memoryGuide = buildFinishedGuide(input);
    return this.memoryGuide.id;
  }

  // -------------------------------------------------------------------------
  // Builder calls (from the MCP relay)
  // -------------------------------------------------------------------------

  private callBuilder(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const run = this.builderQueue.then(() => this.callBuilderNow(name, args));
    this.builderQueue = run.catch(() => {});
    return run;
  }

  private async callBuilderNow(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (!(GUIDE_BUILDER_TOOL_NAMES as readonly string[]).includes(name)) return { text: `Unknown tool ${name}.`, isError: true };
    if (this.state.savedGuideId) return { text: "The guide is already saved. Nothing more to do: end your turn.", isError: false };
    const before = this.state.draft;
    const answer = await runGuideBuilderTool(before, name, args, this.hooks);
    if (answer.changed) {
      this.trackMarks(before, answer.draft, name, args);
      this.state.draft = answer.draft;
      this.persist();
    }
    if (name === "guide_finish" && answer.ok && answer.snapshot) {
      try {
        this.state.status = "finishing";
        this.state.savedGuideId = this.saveGuide(answer.snapshot, answer.draft);
      } catch (err) {
        this.state.status = "running";
        const message = err instanceof Error ? err.message : String(err);
        this.addActivity({ kind: "builder", title: name, detail: message, status: "failed", isError: true });
        this.emit();
        return { text: `The guide could not be saved: ${message}`, isError: true };
      }
      this.addActivity({ kind: "builder", title: name, detail: this.history ? "saved" : "done (not saved: guide history is off)", status: "completed" });
      if (this.state.diagramUnchecked) this.addActivity({ kind: "info", title: "The overview diagram was not render-checked here; it is checked when the guide opens." });
      this.emit();
      const unchecked = this.state.diagramUnchecked ? "\nThe overview diagram could not be render-checked (no Guides tab is open); the reader checks it when the guide opens." : "";
      return { text: `${answer.text}${unchecked}\nThe reader opens the guide now; end your turn.`, isError: false };
    }
    this.addActivity({
      kind: "builder",
      title: name,
      detail: builderDetail(name, args, answer.draft, answer.ok, answer.text),
      status: answer.ok ? "completed" : "failed",
      isError: !answer.ok,
    });
    this.emit();
    return { text: answer.text, isError: !answer.ok };
  }

  private trackMarks(before: GuideDraft, after: GuideDraft, name: string, args: unknown): void {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "guide_add_chapter") {
      const added = after.chapters.find((c) => !before.chapters.some((b) => b.id === c.id));
      if (added) this.state.marks.added = [added.id];
    }
    if (name === "guide_move_file" && typeof a.file === "string") {
      const from = before.chapters.findIndex((c) => c.files.some((f) => f.file === a.file));
      if (from >= 0) this.state.marks.moved[a.file] = from + 1;
    }
  }

  // -------------------------------------------------------------------------
  // ACP updates
  // -------------------------------------------------------------------------

  private onUpdate(notification: SessionNotification): void {
    const u = notification.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content.type !== "text") break;
        if (!this.messageEntry) this.messageEntry = this.addActivity({ kind: "message", title: "" });
        this.messageEntry.title += u.content.text;
        break;
      }
      case "tool_call": {
        this.messageEntry = null;
        if (BUILDER_TITLE.test(u.title ?? "")) break; // shown from the builder side, with its answer
        const entry = this.addActivity({
          kind: "tool",
          title: u.title || "Tool call",
          status: u.status ?? "pending",
          ...(u.locations?.length && { locations: this.relLocations(u.locations) }),
        });
        this.toolEntries.set(u.toolCallId, entry);
        break;
      }
      case "tool_call_update": {
        const entry = this.toolEntries.get(u.toolCallId);
        if (!entry) break;
        if (u.title && !BUILDER_TITLE.test(u.title)) entry.title = u.title;
        if (u.status) entry.status = u.status;
        if (u.locations?.length) entry.locations = this.relLocations(u.locations);
        if (u.status === "failed") entry.isError = true;
        break;
      }
      case "plan": {
        this.messageEntry = null;
        const done = u.entries.filter((e) => e.status === "completed").length;
        const current = u.entries.find((e) => e.status === "in_progress") ?? u.entries.find((e) => e.status === "pending");
        const existing = [...this.state.activity].reverse().find((e) => e.kind === "plan");
        const title = `Plan · ${done} of ${u.entries.length} done${current ? ` · ${current.content}` : ""}`;
        if (existing && existing === this.state.activity[this.state.activity.length - 1]) existing.title = title;
        else this.addActivity({ kind: "plan", title });
        break;
      }
      case "usage_update": {
        if (u.cost && typeof u.cost.amount === "number") this.state.cost = { amount: u.cost.amount, currency: u.cost.currency ?? "USD" };
        break;
      }
      default:
        return;
    }
    this.emit();
  }

  private relLocations(locations: ToolCallLocation[]): Array<{ path: string; line?: number }> {
    const root = this.input.source.headRoot;
    return locations.map((l) => {
      const rel = relative(root, l.path);
      const path = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : l.path;
      return { path, ...(typeof l.line === "number" && { line: l.line }) };
    });
  }

  private async onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const entry = this.addActivity({ kind: "permission", title: `Asks to run: ${request.toolCall.title ?? "a tool"}`, status: "pending" });
    this.emit();
    const answer = await this.deps.requestPermission(request, signal);
    const chosen = answer.outcome.outcome === "selected" ? request.options.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
    entry.status = chosen && chosen.kind.startsWith("allow") ? "completed" : "failed";
    entry.detail = chosen ? chosen.name : "Cancelled";
    this.emit();
    return answer;
  }

  /** The head file a tool location points at, absolute. */
  headPath(path: string): string {
    return isAbsolute(path) ? path : join(this.input.source.headRoot, path);
  }
}

const AUTH_TEXT = /auth(entication)?[_ ]required|not (logged|signed) in|please (log|sign) in|\/login/i;

/** One-line description of a builder call for the activity stream. */
export function builderDetail(name: string, args: unknown, draft: GuideDraft, ok: boolean, answer: string): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const firstLine = answer.split("\n")[0];
  const chapterNo = (ref: unknown) => {
    const i = draft.chapters.findIndex((c) => c.id === ref);
    return i >= 0 ? String(i + 1) : String(ref ?? "?");
  };
  if (!ok) {
    const target = typeof a.file === "string" ? `${a.file}${a.chapter !== undefined ? ` → ${chapterNo(a.chapter)}` : ""}: ` : "";
    return `${target}${firstLine}`;
  }
  switch (name) {
    case "guide_set_header":
      return "title and intent";
    case "guide_set_overview":
      return (a.diagram ? "overview and diagram" : "overview");
    case "guide_add_chapter": {
      const last = [...draft.chapters].reverse().find((c) => c.title === a.title);
      return `${last ? chapterNo(last.id) : draft.chapters.length} · ${String(a.title ?? "")}`;
    }
    case "guide_update_chapter":
      return `chapter ${chapterNo(a.chapter)}`;
    case "guide_move_chapter":
      return `chapter → position ${String(a.position ?? "")}`;
    case "guide_remove_chapter":
      return `removed ${String(a.chapter ?? "")}`;
    case "guide_place_file":
    case "guide_move_file":
      return `${String(a.file ?? "")} → chapter ${chapterNo(a.chapter)}`;
    case "guide_unplace_file":
      return `${String(a.file ?? "")} → not in a chapter`;
    case "guide_read":
      return answer.trim().split("\n").pop() ?? "";
    default:
      return firstLine;
  }
}

function launchReview(input: GenerationInput): GuideLaunchReview {
  const source = input.source;
  return {
    rawPatch: input.rawPatch,
    gitRef: sourceGitRef(source),
    diffType: source.kind === "pr" ? "merge-base" : "since-base",
    base: source.baseSha,
    source: snapshotSource(source),
    ...(input.instructions && { customInstructions: input.instructions }),
  };
}

/** The agent's focus hints per file, for the sidecar. */
function focusMap(draft: GuideDraft): Record<string, readonly GuideFocusRange[]> {
  const out: Record<string, readonly GuideFocusRange[]> = {};
  for (const c of draft.chapters) for (const f of c.files) if (f.focus?.length) out[f.file] = f.focus;
  return out;
}
