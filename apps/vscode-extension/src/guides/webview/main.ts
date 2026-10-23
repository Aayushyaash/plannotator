/**
 * The Guides webviews (one bundle, four modes): the "Guided Reviews" home tab,
 * the generating view, the Guide tab (title, intent, overview with its
 * diagram, chapter list) and the chapter side view. It draws the state the
 * extension sends and reports clicks by name; it runs no agent code.
 */

import "./style.css";
import type {
  ActivityRow,
  ChapterViewState,
  GeneratingViewState,
  GuideViewState,
  HomeViewState,
  LinkInfo,
  ToExtension,
  ToWebview,
  ViewState,
} from "../webview-protocol";
import { renderInlineMarkdown, renderMarkdown } from "./markdown";
import { checkMermaid, renderMermaid } from "./diagram";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const post = (message: ToExtension) => vscode.postMessage(message);
const command = (name: string, ...args: unknown[]) => post({ type: "command", command: name, args });

const root = document.getElementById("root")!;

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string | number | boolean | undefined | null | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function icon(name: string, extra = ""): HTMLElement {
  return h("span", { class: `codicon codicon-${name} ${extra}`, "aria-hidden": "true" });
}

let state: ViewState | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "state") {
    state = msg.state;
    render();
  } else if (msg.type === "linkInfo") {
    const pending = linkRequests.get(msg.reqId);
    linkRequests.delete(msg.reqId);
    pending?.(msg.info);
  } else if (msg.type === "checkMermaid") {
    void checkMermaid(msg.source).then((r) => post({ type: "mermaidResult", reqId: msg.reqId, ok: r.ok, message: r.message, line: r.line }));
  }
});

function render(): void {
  if (!state) return;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  const activityList = root.querySelector(".pn-activity-list");
  const stick = !activityList || activityList.scrollHeight - activityList.scrollTop - activityList.clientHeight < 40;
  const scrollTop = document.scrollingElement?.scrollTop ?? 0;
  root.replaceChildren(
    state.mode === "home" ? renderHome(state)
      : state.mode === "generating" ? renderGenerating(state)
      : state.mode === "guide" ? renderGuide(state)
      : renderChapter(state),
  );
  const list = root.querySelector(".pn-activity-list");
  if (list && stick) list.scrollTop = list.scrollHeight;
  if (document.scrollingElement) document.scrollingElement.scrollTop = scrollTop;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function renderHome(s: HomeViewState): HTMLElement {
  const repoLine = s.repo
    ? h("div", { class: "pn-meta" }, icon("repo"), ` ${s.repo.name}`, h("span", { class: "pn-dot" }, "·"), icon("git-branch"), ` ${s.repo.branch}`, h("span", { class: "pn-dot" }, "·"), s.repo.host)
    : h("div", { class: "pn-meta" }, "Open a folder that is a git repository to see its changes and pull requests.");
  const banner = h("div", { class: "pn-banner" },
    icon("sparkle", "pn-agent-mark"),
    h("span", {}, "New guides use ", h("b", {}, s.defaults.agent), " · ", h("b", {}, s.defaults.model), " · ", h("b", {}, s.defaults.effort), ", with your own ", s.defaults.agent, " settings."),
    h("a", { class: "pn-action", href: "#", onclick: (e) => { e.preventDefault(); command("changeDefaults"); } }, "Change defaults"),
  );
  const cards = h("div", { class: "pn-cards" });
  const pr = s.cards.pr;
  cards.append(
    h("button", { class: `pn-card${pr?.current ? " pn-card-primary" : ""}`, onclick: () => command(pr?.current ? "guideCurrentPR" : "guidePullRequest"), disabled: !pr },
      h("div", { class: "pn-card-title" }, icon("git-pull-request"), " Pull request"),
      h("div", { class: "pn-card-body" }, pr ? (pr.current ? `Guide #${pr.current.number}, the PR for this branch, or pick another open PR.` : "Guide any open PR in this repo, or paste its link.") : s.ghNote ?? "Needs the GitHub CLI (gh)."),
      pr ? h("div", { class: "pn-card-foot" }, h("span", { class: "pn-chip" }, `${pr.open} open`), pr.waiting ? h("span", { class: "pn-chip pn-chip-warn" }, `${pr.waiting} waiting on you`) : null) : null,
    ),
  );
  const local = s.cards.local;
  cards.append(
    h("button", { class: "pn-card", onclick: () => command("guideLocal"), disabled: !local || local.files === 0 },
      h("div", { class: "pn-card-title" }, icon("git-compare"), " Local changes"),
      h("div", { class: "pn-card-body" }, local ? `Everything since ${local.baseLabel}, uncommitted and untracked files included.` : "No repository open."),
      local ? h("div", { class: "pn-card-foot" }, h("span", { class: "pn-add" }, `+${local.additions}`), h("span", { class: "pn-del" }, `−${local.deletions}`), ` ${local.files} ${local.files === 1 ? "file" : "files"}`) : null,
    ),
  );

  const recent = h("section", { class: "pn-col" },
    h("div", { class: "pn-section-head" }, h("span", {}, "Recent guides")),
    s.recent.length === 0
      ? h("div", { class: "pn-empty" }, "No guides for this repo yet. Guides made in Plannotator's web app show here too.")
      : h("div", { class: "pn-rows" }, ...s.recent.map((r) =>
          h("button", { class: "pn-row", onclick: () => command(r.kind === "draft" ? "resumeDraft" : "openGuide", r.id) },
            h("div", { class: "pn-row-main" }, h("div", { class: "pn-row-title" }, r.title), h("div", { class: "pn-row-sub" }, r.sub, r.note ? h("span", { class: r.warn ? "pn-warn" : "pn-muted" }, ` · ${r.note}`) : null)),
            h("div", { class: "pn-row-mid" }, r.progress ? progress(r.progress.reviewed, r.progress.total) : r.kind === "draft" ? h("span", { class: "pn-pill" }, "Resume") : null),
            h("div", { class: "pn-row-when" }, r.when),
          ),
        )),
  );
  const waiting = h("section", { class: "pn-col" },
    h("div", { class: "pn-section-head" }, h("span", {}, "Waiting on you")),
    s.waiting.length === 0
      ? h("div", { class: "pn-empty" }, s.ghNote ?? "No pull requests are waiting on your review.")
      : h("div", { class: "pn-rows" }, ...s.waiting.map((w) =>
          h("div", { class: "pn-row pn-row-static" },
            h("div", { class: "pn-row-main" }, h("div", { class: "pn-row-title" }, `#${w.number} ${w.title}`), h("div", { class: "pn-row-sub" }, w.sub)),
            w.inThisRepo
              ? h("button", { class: "pn-btn", onclick: () => command("guidePullRequest", w.number) }, icon("sparkle"), " Guide")
              : h("button", { class: "pn-btn pn-btn-ghost", title: "Open on GitHub", onclick: () => command("openExternal", w.url) }, icon("link-external")),
          ),
        )),
  );
  return h("div", { class: "pn-page pn-home" },
    h("h1", {}, "Guided Reviews"),
    repoLine,
    banner,
    ...s.notes.map((n) => h("div", { class: "pn-note" }, icon("info"), ` ${n}`)),
    cards,
    h("div", { class: "pn-two" }, recent, waiting),
  );
}

function progress(done: number, total: number): HTMLElement {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (total > 0 && done === total) return h("span", { class: "pn-ok" }, "Reviewed");
  return h("span", { class: "pn-progress" }, h("span", { class: "pn-bar" }, h("span", { class: "pn-bar-fill", style: `width:${pct}%` })), ` ${done} of ${total}`);
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

const CHAPTER_COLORS = ["var(--pn-c1)", "var(--pn-c2)", "var(--pn-c3)", "var(--pn-c4)", "var(--pn-c5)", "var(--pn-c6)"];

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderGenerating(s: GeneratingViewState): HTMLElement {
  const live = s.status === "starting" || s.status === "running" || s.status === "finishing";
  const elapsed = h("div", { class: "pn-stat-value" }, fmtElapsed((s.endedAt ?? Date.now()) - s.startedAt));
  if (live) elapsedTimer = setInterval(() => (elapsed.textContent = fmtElapsed(Date.now() - s.startedAt)), 1000);
  const actions = live
    ? h("div", { class: "pn-actions" },
        h("button", { class: "pn-btn", onclick: () => command("runInBackground", s.id) }, "Run in background"),
        h("button", { class: "pn-btn pn-btn-danger", onclick: () => command("cancel", s.id) }, h("span", { class: "pn-stop" }), "Cancel"),
      )
    : s.status === "finished"
      ? h("div", { class: "pn-actions" }, s.savedGuideId ? h("button", { class: "pn-btn pn-btn-primary", onclick: () => command("openGuide", s.savedGuideId) }, "Open guide") : null)
      : h("div", { class: "pn-actions" },
          ...(s.signIn ?? []).map((label, i) => h("button", { class: `pn-btn${i === 0 ? " pn-btn-primary" : ""}`, onclick: () => command("signIn", label) }, s.signIn!.length === 1 ? "Sign in" : `Sign in: ${label}`)),
          h("button", { class: `pn-btn${s.signIn ? "" : " pn-btn-primary"}`, onclick: () => command("resumeDraft", s.id) }, "Resume"),
          h("button", { class: "pn-btn", onclick: () => command("saveDraftAsIs", s.id) }, "Save as is"),
        );
  const statusLine = s.statusMessage && !live
    ? h("div", { class: `pn-status ${s.status === "failed" ? "pn-status-error" : s.status === "finished" ? "pn-status-ok" : ""}` },
        icon(s.status === "failed" ? "error" : s.status === "finished" ? "pass" : "debug-pause"), " ", s.statusMessage)
    : s.memoryOnly && live
      ? h("div", { class: "pn-status" }, icon("info"), " Guide history is off: this guide and its draft are not saved, only kept until VS Code closes.")
      : null;
  const header = h("div", { class: "pn-gen-head" },
    h("div", { class: `pn-spinner${live ? "" : " pn-spinner-off"}` }),
    h("div", { class: "pn-gen-titles" },
      h("div", { class: "pn-kicker" }, s.kicker),
      h("h1", {}, s.title),
      h("div", { class: "pn-meta" }, s.sub),
    ),
    actions,
  );
  const stats = h("div", { class: "pn-stats" },
    stat("Agent", h("span", {}, icon("sparkle", "pn-agent-mark"), ` ${s.agent}`)),
    stat("Model · effort", s.modelEffort),
    stat("Elapsed", elapsed),
    stat("Cost", s.cost ? h("span", {}, h("b", {}, s.cost), h("span", { class: "pn-muted" }, " reported by the agent")) : h("span", { class: "pn-muted" }, "not reported")),
  );
  const activity = h("section", { class: "pn-panel" },
    h("div", { class: "pn-panel-head" }, h("span", {}, "Activity"), h("span", { class: "pn-muted" }, live ? "live from the agent" : "")),
    h("div", { class: "pn-activity-list", role: "log", "aria-live": "polite" }, ...s.activity.map(activityRow)),
  );
  const draft = h("section", { class: "pn-panel" },
    h("div", { class: "pn-panel-head" }, h("span", {}, "Draft"), h("span", { class: "pn-muted" }, live ? "updates as the agent builds it" : s.summary)),
    h("div", { class: "pn-draft" },
      ...(s.chapters.length === 0 ? [h("div", { class: "pn-empty" }, "No chapters yet.")] : s.chapters.map((c, i) =>
        h("div", { class: `pn-draft-ch${c.added ? " pn-draft-new" : ""}` },
          h("div", { class: "pn-draft-title" }, h("span", { class: "pn-cdot", style: `background:${CHAPTER_COLORS[i % CHAPTER_COLORS.length]}` }), `${c.n}. ${c.title}`, c.added ? h("span", { class: "pn-tag pn-tag-ok" }, "added") : null),
          c.files.length === 0
            ? h("div", { class: "pn-muted pn-draft-files" }, "no files yet")
            : h("div", { class: "pn-draft-files" }, ...c.files.map((f) =>
                h("span", { class: `pn-file-chip${f.movedFrom ? " pn-file-moved" : ""}`, title: f.path }, f.name, f.movedFrom ? h("span", { class: "pn-moved" }, ` moved from ${f.movedFrom}`) : null))),
        ))),
      s.unplaced.length ? h("div", { class: "pn-draft-foot" }, icon("circle-slash"), ` Not in a chapter: ${s.unplaced.join(", ")}`) : null,
      s.left.length
        ? h("div", { class: "pn-draft-foot" }, icon("circle-large-outline"), " Not placed yet: ", h("code", {}, s.left.slice(0, 6).join(", ") + (s.left.length > 6 ? `, +${s.left.length - 6}` : "")))
        : s.chapters.length ? h("div", { class: "pn-draft-foot pn-ok" }, icon("pass"), " Every changed file is accounted for") : null,
    ),
  );
  return h("div", { class: "pn-page pn-gen" }, header, statusLine, stats, h("div", { class: "pn-two pn-two-gen" }, activity, draft));
}

function stat(label: string, value: Node | string): HTMLElement {
  return h("div", { class: "pn-stat" }, h("div", { class: "pn-stat-label" }, label), typeof value === "string" ? h("div", { class: "pn-stat-value" }, value) : value);
}

function activityRow(a: ActivityRow): HTMLElement {
  const iconName = a.kind === "message" ? "comment" : a.kind === "builder" ? "book" : a.kind === "plan" ? "checklist" : a.kind === "permission" ? "shield" : a.kind === "error" ? "error" : a.kind === "info" ? "info" : toolIcon(a.title);
  const cls = `pn-act pn-act-${a.kind}${a.isError ? " pn-act-error" : ""}${a.status === "in_progress" || a.status === "pending" ? " pn-act-live" : ""}`;
  const body = h("div", { class: "pn-act-body" });
  if (a.kind === "builder") body.append(h("code", { class: "pn-tool" }, a.title), " ", a.detail ?? "");
  else if (a.kind === "tool") body.append(...toolTitle(a));
  else if (a.kind === "permission") body.append(a.title, a.detail ? h("span", { class: "pn-muted" }, ` · ${a.detail}`) : "");
  else body.append(a.title, a.detail ? h("div", { class: "pn-act-detail" }, a.detail) : "");
  return h("div", { class: cls }, icon(a.isError ? "warning" : iconName, "pn-act-icon"), body, h("span", { class: "pn-act-at" }, a.at));
}

function toolIcon(title: string): string {
  if (/^(Read|View)\b/i.test(title)) return "file";
  if (/^(Run|Ran|Bash|`)/i.test(title)) return "terminal";
  if (/^(Search|Grep|Find)/i.test(title)) return "search";
  return "tools";
}

/** A tool title with its file locations as links. */
function toolTitle(a: ActivityRow): Node[] {
  const out: Node[] = [];
  let title = a.title;
  const loc = a.locations?.[0];
  if (loc && title.includes(loc.path)) {
    const [before, after] = [title.slice(0, title.indexOf(loc.path)), title.slice(title.indexOf(loc.path) + loc.path.length)];
    out.push(document.createTextNode(before), locationLink(loc), document.createTextNode(after));
    return out;
  }
  const runMatch = /^(Ran|Run)\s+`?(.+?)`?$/.exec(title);
  if (runMatch) {
    out.push(document.createTextNode(`${runMatch[1]} `), h("code", { class: "pn-cmd" }, runMatch[2]));
    title = "";
  } else out.push(document.createTextNode(title));
  if (loc) out.push(document.createTextNode(" "), locationLink(loc));
  return out;
}

function locationLink(loc: { path: string; line?: number }): HTMLElement {
  return h("a", { class: "pn-loc", href: "#", onclick: (e) => { e.preventDefault(); command("openLocation", loc.path, loc.line ?? null); } }, loc.path);
}

// ---------------------------------------------------------------------------
// Guide tab
// ---------------------------------------------------------------------------

function renderGuide(s: GuideViewState): HTMLElement {
  const page = h("div", { class: "pn-page pn-guide" },
    h("div", { class: "pn-kicker" }, s.kicker),
    h("h1", {}, s.title),
    h("div", { class: "pn-intent" }, renderMarkdown(s.intent)),
    s.moved ? h("div", { class: "pn-note pn-warn" }, icon("warning"), " The head moved since this guide was made: line numbers may have shifted.") : null,
  );
  if (s.overview) {
    page.append(h("div", { class: "pn-section-head" }, h("span", {}, "Overview")));
    page.append(h("div", { class: "pn-prose" }, renderMarkdown(s.overview.text)));
    if (s.overview.diagram?.kind === "mermaid") page.append(diagramCard(s.overview.diagram.source));
  }
  page.append(h("div", { class: "pn-section-head" }, h("span", {}, "Chapters"), h("span", { class: "pn-muted" }, `${s.reviewed} of ${s.chapters.length} reviewed`)));
  page.append(h("div", { class: "pn-chapters" }, ...s.chapters.map((c) =>
    h("button", { class: `pn-chapter${c.reviewed ? " pn-chapter-done" : ""}`, onclick: () => command("openChapter", c.n) },
      h("span", { class: "pn-chapter-n", style: `background:${c.color}` }, String(c.n)),
      h("div", { class: "pn-chapter-main" }, h("div", { class: "pn-chapter-title" }, c.title), h("div", { class: "pn-chapter-files" }, c.files.join(" · "))),
      c.reviewed ? h("span", { class: "pn-ok" }, "✓ reviewed") : h("span", { class: "pn-muted" }, `${c.files.length} ${c.files.length === 1 ? "file" : "files"}`),
    ))));
  return page;
}

function diagramCard(source: string): HTMLElement {
  const canvas = h("div", { class: "pn-diagram-canvas" }, h("div", { class: "pn-muted pn-diagram-wait" }, "Drawing the diagram…"));
  const card = h("div", { class: "pn-diagram" },
    h("div", { class: "pn-diagram-head" }, icon("type-hierarchy-sub"), " Mermaid", h("span", { class: "pn-muted" }, " · Click a box to open its code · hover for details")),
    canvas,
  );
  void renderMermaid(source).then((r) => {
    if (r.ok) canvas.replaceChildren(r.svg);
    else canvas.replaceChildren(h("div", { class: "pn-status pn-status-error" }, `The diagram does not render${r.line ? ` (line ${r.line})` : ""}: ${r.message}`), h("pre", { class: "pn-pre" }, source));
  });
  return card;
}

// ---------------------------------------------------------------------------
// Chapter side view
// ---------------------------------------------------------------------------

function renderChapter(s: ChapterViewState): HTMLElement {
  if (s.empty) return h("div", { class: "pn-side pn-muted" }, "Open a chapter of the guide to read why it changed.");
  return h("div", { class: "pn-side" },
    h("h2", {}, s.title ?? ""),
    h("div", { class: "pn-prose pn-prose-side" }, renderMarkdown(s.overview ?? "")),
    h("div", { class: "pn-side-files" }, ...(s.files ?? []).map((f) =>
      h("div", { class: "pn-side-file" },
        h("a", { class: "pn-loc pn-mono", href: "#", onclick: (e) => { e.preventDefault(); command("openFile", f.path); } }, f.name),
        f.reviewed ? h("span", { class: "pn-ok" }, " ✓") : null,
        f.summary ? h("span", { class: "pn-muted" }, " · ", renderInlineMarkdown(f.summary)) : null,
      ))),
    h("div", { class: "pn-side-actions" },
      s.reviewed
        ? h("button", { class: "pn-btn", onclick: () => command("markChapterReviewed", s.n, false) }, icon("check"), " Reviewed")
        : h("button", { class: "pn-btn pn-btn-primary", onclick: () => command("markChapterReviewed", s.n, true) }, icon("check"), " Mark chapter reviewed"),
      s.hasNext ? h("button", { class: "pn-btn", onclick: () => command("nextChapter") }, "Next chapter ›") : null,
    ),
    s.footer ? h("div", { class: "pn-side-foot pn-muted" }, icon("sparkle", "pn-agent-mark"), ` ${s.footer}`) : null,
  );
}

// ---------------------------------------------------------------------------
// Links: click opens, hover shows the code-intelligence popover
// ---------------------------------------------------------------------------

let nextReq = 1;
const linkRequests = new Map<number, (info: LinkInfo) => void>();
let popover: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let popoverFor: Element | null = null;

function linkTarget(el: EventTarget | null): Element | null {
  return el instanceof Element ? el.closest("[data-link]") : null;
}

document.addEventListener("click", (e) => {
  const ext = e.target instanceof Element ? e.target.closest("[data-external]") : null;
  if (ext) {
    e.preventDefault();
    command("openExternal", ext.getAttribute("data-external"));
    return;
  }
  const action = e.target instanceof Element ? e.target.closest("[data-popover-action]") : null;
  if (action) {
    e.preventDefault();
    post({ type: "link", link: action.getAttribute("data-popover-link") ?? "", action: action.getAttribute("data-popover-action") as "open" | "definition" | "references" });
    hidePopover();
    return;
  }
  const link = linkTarget(e.target);
  if (!link) return;
  e.preventDefault();
  post({ type: "link", link: link.getAttribute("data-link") ?? "", action: "open" });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hidePopover();
  if (e.key !== "Enter") return;
  const link = linkTarget(document.activeElement);
  if (link) post({ type: "link", link: link.getAttribute("data-link") ?? "", action: "open" });
});

function scheduleShow(el: Element): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (popoverFor === el) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showPopover(el), 350);
}

document.addEventListener("mouseover", (e) => {
  if (e.target instanceof Element && e.target.closest(".pn-popover")) {
    if (hideTimer) clearTimeout(hideTimer);
    return;
  }
  const link = linkTarget(e.target);
  if (link) scheduleShow(link);
});
document.addEventListener("mouseout", (e) => {
  const to = (e as MouseEvent).relatedTarget;
  if (to instanceof Element && (to.closest(".pn-popover") || linkTarget(to) === popoverFor)) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  hideTimer = setTimeout(hidePopover, 250);
});
document.addEventListener("focusin", (e) => {
  const link = linkTarget(e.target);
  if (link) scheduleShow(link);
});

function hidePopover(): void {
  popover?.remove();
  popover = null;
  popoverFor = null;
}

function showPopover(el: Element): void {
  const link = el.getAttribute("data-link");
  if (!link) return;
  hidePopover();
  popoverFor = el;
  const box = h("div", { class: "pn-popover", role: "dialog", "aria-label": `About ${link}` }, h("div", { class: "pn-muted pn-pop-pad" }, "Asking the language server…"));
  popover = box;
  document.body.append(box);
  place(box, el);
  const reqId = nextReq++;
  linkRequests.set(reqId, (info) => {
    if (popover !== box) return;
    box.replaceChildren(...popoverBody(info, link));
    place(box, el);
  });
  post({ type: "linkInfo", reqId, link });
}

function place(box: HTMLElement, el: Element): void {
  const r = el.getBoundingClientRect();
  const width = Math.min(480, window.innerWidth - 24);
  box.style.width = `${width}px`;
  const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
  box.style.left = `${left + window.scrollX}px`;
  const below = r.bottom + 6;
  const height = box.offsetHeight;
  const top = below + height > window.innerHeight && r.top - height - 6 > 0 ? r.top - height - 6 : below;
  box.style.top = `${top + window.scrollY}px`;
}

function popoverBody(info: LinkInfo, link: string): Node[] {
  if (!info.ok) return [h("div", { class: "pn-pop-pad" }, h("div", { class: "pn-pop-title" }, info.label), h("div", { class: "pn-muted" }, info.message ?? "Not found."))];
  const nodes: Node[] = [h("div", { class: "pn-pop-head" }, h("b", { class: "pn-mono" }, info.label), info.location ? h("span", { class: "pn-muted pn-mono" }, info.location) : null)];
  if (info.hover) nodes.push(h("div", { class: "pn-pop-hover pn-prose" }, renderMarkdown(info.hover)));
  const facts = h("div", { class: "pn-pop-facts" });
  if (info.chapter) {
    facts.append(h("span", { class: "pn-cdot", style: `background:${info.chapter.color}` }), " Changed in ", h("b", {}, `Chapter ${info.chapter.n} · ${info.chapter.title}`));
    if (info.chapter.reviewed) facts.append(h("span", { class: "pn-ok" }, " ✓ reviewed"));
  } else if (!info.inChange) facts.append(h("span", { class: "pn-muted" }, "Not changed in this guide"));
  if (info.references !== undefined) facts.append(h("span", { class: "pn-muted" }, ` · ${info.references} ${info.references === 1 ? "reference" : "references"}`));
  if (info.definedIn) facts.append(h("span", { class: "pn-muted" }, ` · defined in ${info.definedIn}`));
  nodes.push(facts);
  const isSymbol = link.startsWith("symbol:");
  nodes.push(h("div", { class: "pn-pop-actions" },
    h("button", { class: "pn-btn pn-btn-primary pn-btn-sm", "data-popover-action": "open", "data-popover-link": link }, info.inChange ? "Open diff" : "Open file"),
    isSymbol || link.startsWith("code:") ? h("a", { href: "#", "data-popover-action": "definition", "data-popover-link": link }, "Go to definition") : null,
    isSymbol || link.startsWith("code:") ? h("a", { href: "#", "data-popover-action": "references", "data-popover-link": link }, "Find references") : null,
    h("span", { class: "pn-muted pn-mono pn-pop-link" }, link),
  ));
  return nodes;
}

post({ type: "ready" });
