/**
 * Messages between the Guides webviews and the extension. Types only; both
 * sides import them. The webview never decides anything: it draws a state the
 * extension sends and reports clicks by name.
 */

export interface HomeViewState {
  mode: "home";
  repo: { name: string; branch: string; host: string } | null;
  defaults: { agent: string; model: string; effort: string };
  ghNote: string | null;
  cards: {
    pr: { open: number; waiting: number; current: { number: number; title: string } | null } | null;
    local: { files: number; additions: number; deletions: number; baseLabel: string } | null;
  };
  recent: Array<{
    kind: "guide" | "draft";
    id: string;
    title: string;
    sub: string;
    progress: { reviewed: number; total: number } | null;
    note: string | null;
    warn: boolean;
    when: string;
  }>;
  waiting: Array<{ url: string; number: number; title: string; sub: string; inThisRepo: boolean }>;
  notes: string[];
}

export interface ActivityRow {
  id: number;
  at: string;
  kind: "message" | "tool" | "builder" | "plan" | "permission" | "info" | "error";
  title: string;
  detail?: string;
  status?: string;
  isError?: boolean;
  /** For tool calls: a file the call touched, as a link the extension opens. */
  locations?: Array<{ path: string; line?: number }>;
}

export interface GeneratingViewState {
  mode: "generating";
  id: string;
  status: "starting" | "running" | "finishing" | "finished" | "stopped" | "failed";
  statusMessage: string | null;
  kicker: string;
  title: string;
  sub: string;
  agent: string;
  modelEffort: string;
  startedAt: number;
  endedAt: number | null;
  cost: string | null;
  activity: ActivityRow[];
  chapters: Array<{ n: number; id: string; title: string; added: boolean; files: Array<{ path: string; name: string; movedFrom: number | null }> }>;
  unplaced: string[];
  left: string[];
  summary: string;
  savedGuideId: string | null;
  /** The run failed because the agent is not signed in: one button per login the agent offers. */
  signIn: string[] | null;
  /** Guide history is off: nothing of this run is saved. */
  memoryOnly: boolean;
  /** Permission requests waiting on the user, with every option the agent offers. */
  pendingPermissions: Array<{ id: number; title: string; kind: string | null; target: string | null; options: Array<{ optionId: string; name: string; kind: string }> }>;
  /** How the agent's requests are answered: by the user, or automatically (and in which mode of the agent's own). */
  approvals: { auto: boolean; mode: string | null };
  /** Offer automatic approval inline (the first request reached the user while it was off). */
  offerAutoApprove: boolean;
  /** What in the agent's setup holds the run back, with one click that helps where there is one. */
  bottlenecks: Array<{ key: string; title: string; detail: string | null; action: "approveRun" | "resumeWithApproval" | null }>;
}

export interface OverviewData {
  text: string;
  diagram?: { kind: "mermaid" | "html"; source: string };
}

export interface GuideViewState {
  mode: "guide";
  guideId: string;
  kicker: string;
  title: string;
  intent: string;
  overview: OverviewData | null;
  chapters: Array<{ n: number; title: string; files: string[]; reviewed: boolean; color: string }>;
  reviewed: number;
  moved: boolean;
}

export interface ChapterViewState {
  mode: "chapter";
  empty: boolean;
  n?: number;
  total?: number;
  title?: string;
  overview?: string;
  files?: Array<{ path: string; name: string; summary: string; reviewed: boolean }>;
  reviewed?: boolean;
  hasNext?: boolean;
  footer?: string;
}

export type ViewState = HomeViewState | GeneratingViewState | GuideViewState | ChapterViewState;

/** What the code-intelligence popover shows for a link (SPEC 3.5, "Hover"). */
export interface LinkInfo {
  ok: boolean;
  label: string;
  /** "src/webhooks/deliver.ts:13" */
  location?: string;
  /** Markdown from the language server's hover (signature and doc). */
  hover?: string;
  definedIn?: string;
  references?: number;
  chapter?: { n: number; title: string; reviewed: boolean; color: string };
  inChange: boolean;
  message?: string;
}

export type ToExtension =
  | { type: "ready" }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "link"; link: string; action: "open" | "definition" | "references" }
  | { type: "linkInfo"; reqId: number; link: string }
  | { type: "mermaidResult"; reqId: number; ok: boolean; message?: string; line?: number };

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "linkInfo"; reqId: number; info: LinkInfo }
  | { type: "checkMermaid"; reqId: number; source: string };

/** Commands a webview may send. Anything else is ignored. */
export const WEBVIEW_COMMANDS = [
  "newReview",
  "guideLocal",
  "guidePullRequest",
  "guideCurrentPR",
  "openGuide",
  "resumeDraft",
  "saveDraftAsIs",
  "deleteDraft",
  "cancel",
  "runInBackground",
  "openLocation",
  "openChapter",
  "markChapterReviewed",
  "nextChapter",
  "openFile",
  "changeDefaults",
  "openExternal",
  "refresh",
  "exportGuide",
  "signIn",
  "answerPermission",
  "approveRun",
  "approveAlways",
  "resumeWithApproval",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];
