/**
 * Screenshots of the run view's approvals and bottleneck notices: the built
 * webview bundle (`bun run build` first) in headless Chromium, with VS Code's
 * Dark Modern colors and canned run states. No agent and no VS Code run here.
 * Manual check, not CI:
 *
 *   bun tests/screenshots/approvals.ts <out dir>
 */

import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GeneratingViewState } from "../../src/guides/webview-protocol";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: approvals.ts <out dir>");
mkdirSync(outDir, { recursive: true });
const dist = join(import.meta.dir, "..", "..", "dist");

/** A subset of VS Code's Dark Modern theme variables the webview reads. */
const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, monospace;
  --vscode-foreground: #cccccc; --vscode-editor-foreground: #cccccc; --vscode-sideBar-background: #181818; --vscode-descriptionForeground: #9d9d9d; --vscode-editor-background: #1f1f1f;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-focusBorder: #0078d4; --vscode-errorForeground: #f85149; --vscode-editorWarning-foreground: #cca700;
  --vscode-inputValidation-infoBackground: #0b2a45; --vscode-inputValidation-warningBackground: #352a05; --vscode-inputValidation-warningBorder: #b89500;
  --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131; --vscode-textLink-foreground: #4daafc; --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-testing-iconPassed: #73c991; --vscode-list-hoverBackground: #2a2d2e; --vscode-textCodeBlock-background: #2b2b2b;
}
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; }
`;

const base: GeneratingViewState = {
  mode: "generating",
  id: "draft-1",
  status: "running",
  statusMessage: null,
  kicker: "Building guided review · PR #482",
  title: "Retry failed webhook deliveries",
  sub: "github.com/northwind/checkout-service/pull/482 · in a worktree at 9b07e4d",
  agent: "Claude Code",
  modelEffort: "Sonnet · Low",
  startedAt: Date.now() - 74_000,
  endedAt: null,
  cost: "$0.06",
  activity: [
    { id: 1, at: "0:00", kind: "info", title: "Starting Claude Code", detail: "With your own settings: you approve what it asks about." },
    { id: 2, at: "0:04", kind: "message", title: "Reading the change first: the retry policy, then the delivery loop." },
    { id: 3, at: "0:09", kind: "tool", title: "Read src/retryPolicy.ts", status: "completed", locations: [{ path: "src/retryPolicy.ts", line: 1 }] },
    { id: 4, at: "0:15", kind: "builder", title: "guide_set_header", detail: "title and intent", status: "completed" },
    { id: 5, at: "0:21", kind: "builder", title: "guide_add_chapter", detail: "1 · The retry budget", status: "completed" },
    { id: 6, at: "1:12", kind: "permission", title: "Waiting for your approval: Run npm test -- retryPolicy", detail: "npm test -- retryPolicy", status: "pending" },
  ],
  chapters: [
    { n: 1, id: "c1", title: "The retry budget", added: true, files: [{ path: "src/retryPolicy.ts", name: "retryPolicy.ts", movedFrom: null }] },
    { n: 2, id: "c2", title: "Delivery loop learns to back off", added: false, files: [] },
  ],
  unplaced: [],
  left: ["src/deliver.ts", "src/deliver.test.ts"],
  summary: "2 chapters · 1 of 3 files placed",
  savedGuideId: null,
  signIn: null,
  memoryOnly: false,
  pendingPermissions: [
    {
      id: 1,
      title: "Run npm test -- retryPolicy",
      kind: "execute",
      target: "npm test -- retryPolicy",
      options: [
        { optionId: "allow", name: "Yes", kind: "allow_once" },
        { optionId: "allow_always", name: "Yes, and don't ask again for npm test", kind: "allow_always" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    },
  ],
  approvals: { auto: false, mode: null },
  offerAutoApprove: true,
  bottlenecks: [],
};

const shots: Array<{ name: string; state: GeneratingViewState; element?: string }> = [
  { name: "permission-prompt", state: base },
  { name: "opt-in-offer", state: base, element: "[data-offer='auto-approve']" },
  {
    name: "auto-approve-on",
    state: {
      ...base,
      pendingPermissions: [],
      offerAutoApprove: false,
      approvals: { auto: true, mode: "acceptEdits" },
      activity: [
        ...base.activity.slice(0, 5),
        { id: 6, at: "1:12", kind: "info", title: "Approving the agent's requests automatically for the rest of this run" },
        { id: 7, at: "1:12", kind: "info", title: "Switched Claude Code to acceptEdits for automatic approval" },
        { id: 8, at: "1:13", kind: "permission", title: "Allowed: Run npm test -- retryPolicy", detail: "Yes", status: "completed" },
      ],
    },
  },
  {
    name: "bottleneck",
    state: {
      ...base,
      agent: "Codex",
      modelEffort: "gpt-5.5-codex · Low",
      pendingPermissions: [],
      offerAutoApprove: false,
      bottlenecks: [
        { key: "turned-down", title: "You turned down Run npm test -- retryPolicy", detail: "Codex will try another way. Approve automatically to let its requests through for the rest of this run.", action: "approveRun" },
        { key: "blocked:sandbox:Run git fetch", title: "Codex's sandbox blocked Run git fetch", detail: "\"error: cannot open .git/FETCH_HEAD: Read-only file system\" The guide can still be written without it. Approving automatically switches Codex to a mode that lets it run, where it has one.", action: "approveRun" },
      ],
    },
  },
  {
    name: "bottleneck-stopped",
    state: {
      ...base,
      status: "stopped",
      endedAt: Date.now(),
      statusMessage: "The agent ended its turn without calling guide_finish.",
      pendingPermissions: [],
      offerAutoApprove: false,
      bottlenecks: [
        { key: "turned-down", title: "You turned down Run npm test -- retryPolicy", detail: "Claude Code will try another way. Approve automatically to let its requests through for the rest of this run.", action: "approveRun" },
        { key: "ended-blocked", title: "The run ended after requests were turned down or blocked", detail: "Resume it with automatic approval to let the agent's requests through.", action: "resumeWithApproval" },
      ],
    },
  },
];

const work = mkdtempSync(join(tmpdir(), "pn-approvals-shots-"));
try {
  const html = join(work, "index.html");
  writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${THEME}</style>
<link rel="stylesheet" href="${pathToFileURL(join(dist, "codicons", "codicon.css"))}">
<link rel="stylesheet" href="${pathToFileURL(join(dist, "guides-webview.css"))}">
</head><body class="pn-mode-generating"><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>
<script src="${pathToFileURL(join(dist, "guides-webview.js"))}"></script>
</body></html>`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(html).toString());
    for (const shot of shots) {
      await page.evaluate((state) => window.postMessage({ type: "state", state }, "*"), shot.state as unknown as Record<string, unknown>);
      await page.waitForTimeout(150);
      const path = join(outDir, `${shot.name}.png`);
      if (shot.element) await page.locator(shot.element).screenshot({ path });
      else await page.screenshot({ path, fullPage: true });
      console.log(path);
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
