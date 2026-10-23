/**
 * One guide run: the agent over ACP, the builder draft behind the MCP relay,
 * and the state the generating view draws (SPEC 3.3, 4.1 to 4.4).
 *
 * No `vscode` here: the VS Code layer passes in how to ask for a permission,
 * how to resolve a symbol and how to render-check Mermaid, and draws `state`.
 * The draft is written to disk after every builder call, so a stopped run can
 * be resumed or saved as is.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, ToolCallLocation } from "@agentclientprotocol/sdk";
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
import { AcpClient, readConfigSelect, type AcpClientInfo, type AgentLaunch } from "./acp/client";
import type { RelayHost, RelaySession } from "./mcp/relay-host";
import type { ChangedFileInfo } from "./sources/git";
import { buildGuidePrompt } from "./prompt";
import {
  deleteDraftRecord,
  newDraftId,
  saveDraftRecord,
  saveFinishedGuide,
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

  constructor(
    private readonly input: GenerationInput,
    private readonly deps: GenerationDeps,
  ) {
    this.now = deps.now ?? Date.now;
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

  private persist(): void {
    if (this.state.status === "finished") return;
    const record: DraftRecord = {
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
      const session = await this.client.newSession(source.headRoot, [mcpServer]);
      this.state.acpSessionId = session.sessionId;
      await this.applyChoices(session.sessionId, session.configOptions ?? []);
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
      this.state.status = "failed";
      this.state.statusMessage = authHint(message) ?? message;
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
    this.state.statusMessage = "Saved.";
    deleteDraftRecord(this.input.repoKey, this.state.id);
    this.emit();
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
    return saveFinishedGuide({
      repoKey: this.input.repoKey,
      snapshot,
      source: this.input.source,
      agent: { ...this.input.agent },
      focus: focusMap(draft),
      ...(this.state.acpSessionId && { acpSessionId: this.state.acpSessionId }),
      ...(this.state.cost && { cost: this.state.cost }),
      now: this.now(),
    });
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
      this.addActivity({ kind: "builder", title: name, detail: "saved", status: "completed" });
      this.emit();
      return { text: `${answer.text}\nThe reader opens the guide now; end your turn.`, isError: false };
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

function authHint(message: string): string | null {
  if (/auth(entication)?[_ ]required|not (logged|signed) in|please (log|sign) in|\/login/i.test(message)) {
    return `Claude Code is not signed in. Run \`claude\` in a terminal and sign in (/login), then try again.\n${message}`;
  }
  return null;
}

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
