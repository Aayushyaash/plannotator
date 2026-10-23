import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDashboard } from "./dashboard";
import { parsePullRequestRef, preparePullRequestWorktree } from "./sources/github";
import type { RunResult, Runner } from "./sources/runner";
import { saveDraftRecord, saveFinishedGuide } from "./store";
import { createGuideDraft } from "./core/adapter";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";

type Rule = [RegExp, RunResult | ((cmd: string) => RunResult)];

/** A runner that answers from rules matched against "cmd arg arg …"; anything else fails loudly. */
function scripted(rules: Rule[], calls: string[] = []): Runner {
  return async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    for (const [re, res] of rules) if (re.test(line)) return typeof res === "function" ? res(line) : res;
    return { code: 1, stdout: "", stderr: `unscripted: ${line}` };
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

const gitRules: Rule[] = [
  [/git .*rev-parse --show-toplevel/, ok("/repo/checkout-service\n")],
  [/git .*rev-parse --abbrev-ref HEAD/, ok("feat/webhook-retries\n")],
  [/git .*rev-parse HEAD$/, ok("9b07e4d9b07e4d9b07e4d9b07e4d9b07e4d9b07e\n")],
  [/git .*remote get-url origin/, ok("git@github.com:northwind/checkout-service.git\n")],
  [/git .*symbolic-ref refs\/remotes\/origin\/HEAD/, ok("refs/remotes/origin/main\n")],
  [/git .*show-ref --verify --quiet refs\/remotes\/origin\/main/, ok("")],
  [/git .*merge-base origin\/main HEAD/, ok("3f2c1a93f2c1a93f2c1a93f2c1a93f2c1a93f2c1\n")],
  [/git .*diff --numstat 3f2c1a9/, ok("12\t3\tsrc/webhooks/deliver.ts\n6\t1\tsrc/webhooks/retryPolicy.ts\n-\t-\tlogo.png\n")],
  [/git .*ls-files --others --exclude-standard/, ok("notes.md\n")],
];

const prList = JSON.stringify([
  { number: 477, title: "Add idempotency keys", url: "https://github.com/northwind/checkout-service/pull/477", author: { login: "li" }, isDraft: false, headRefName: "feat/idem", headRefOid: "aaa", baseRefName: "main", additions: 50, deletions: 2, changedFiles: 4, updatedAt: "2026-10-20T10:00:00Z", reviewRequests: [] },
  { number: 479, title: "Move signing secrets to KMS", url: "https://github.com/northwind/checkout-service/pull/479", author: { login: "dana" }, isDraft: false, headRefName: "feat/kms", headRefOid: "bbb", baseRefName: "main", additions: 30, deletions: 9, changedFiles: 6, updatedAt: "2026-10-19T10:00:00Z", reviewRequests: [{ login: "ramos" }] },
  { number: 482, title: "Retry failed webhook deliveries", url: "https://github.com/northwind/checkout-service/pull/482", author: { login: "ramos" }, isDraft: false, headRefName: "feat/webhook-retries", headRefOid: "9b07e4d", baseRefName: "main", additions: 127, deletions: 19, changedFiles: 8, updatedAt: "2026-10-18T10:00:00Z", reviewRequests: [] },
]);

const waiting = JSON.stringify([
  { number: 212, title: "Format currency per locale", url: "https://github.com/northwind/ledger-ui/pull/212", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "kofi" }, updatedAt: "2026-10-17T00:00:00Z", isDraft: false },
  { number: 214, title: "Keyboard nav for the filter bar", url: "https://github.com/northwind/ledger-ui/pull/214", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "ines" }, updatedAt: "2026-10-21T00:00:00Z", isDraft: false },
]);

describe("dashboard data", () => {
  it("reads this repo, its local changes, its PRs (yours and waiting on you first) and PRs waiting on you", async () => {
    const calls: string[] = [];
    const runner = scripted([
      ...gitRules,
      [/^gh api user --jq \.login$/, ok("ramos\n")],
      [/^gh pr list --state open --limit 30 --json /, ok(prList)],
      [/^gh search prs --review-requested=@me --state=open --limit 15 --json /, ok(waiting)],
    ], calls);
    const model = await loadDashboard(runner, "/repo/checkout-service/src", { now: () => 42 });
    expect(model.repo).toMatchObject({
      root: "/repo/checkout-service",
      displayName: "northwind/checkout-service",
      branch: "feat/webhook-retries",
      defaultBranch: "origin/main",
      repoKey: "github.com__northwind__checkout-service",
    });
    expect(model.local).toEqual({ mode: "since-base", baseSha: "3f2c1a93f2c1a93f2c1a93f2c1a93f2c1a93f2c1", baseLabel: "main", files: 4, additions: 18, deletions: 4, untracked: 1 });
    expect(model.gh).toEqual({ state: "ok", user: "ramos" });
    expect(model.prs.map((p) => [p.number, p.isMine, p.reviewRequested])).toEqual([[482, true, false], [479, false, true], [477, false, false]]);
    expect(model.currentBranchPR?.number).toBe(482);
    expect(model.waiting.map((w) => w.number)).toEqual([214, 212]);
    expect(model.notes).toEqual([]);
    expect(calls.some((c) => c.startsWith("gh") && /--web|checkout|merge|comment|review --/.test(c))).toBe(false);
  });

  it("works without gh: local changes still show, and the state says gh is missing", async () => {
    const runner = scripted([...gitRules, [/^gh /, { code: 127, stdout: "", stderr: "spawn gh ENOENT" }]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.gh).toEqual({ state: "missing" });
    expect(model.prs).toEqual([]);
    expect(model.local?.files).toBe(4);
  });

  it("says when gh is signed out", async () => {
    const runner = scripted([...gitRules, [/^gh api user/, { code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.gh.state).toBe("signed-out");
  });

  it("keeps going when listing PRs fails, with a note", async () => {
    const runner = scripted([
      ...gitRules,
      [/^gh api user/, ok("ramos")],
      [/^gh pr list/, { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }],
      [/^gh search prs/, ok("[]")],
    ]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.notes).toEqual(["Could not list pull requests: HTTP 502: Bad Gateway"]);
    expect(model.local).not.toBeNull();
  });

  it("is empty outside a git repository", async () => {
    const runner = scripted([[/^gh api user/, ok("ramos")], [/^gh search prs/, ok(waiting)]]);
    const model = await loadDashboard(runner, "/tmp/not-a-repo");
    expect(model.repo).toBeNull();
    expect(model.local).toBeNull();
    expect(model.waiting).toHaveLength(2);
  });

  it("lists recent guides and drafts, flags a guide whose PR head moved", async () => {
    const repoKey = "github.com__northwind__checkout-service";
    const source = {
      kind: "pr" as const, repoRoot: "/repo", headRoot: "/wt", repoName: "northwind/checkout-service", label: "PR #479",
      headSha: "old-head", baseSha: "base", baseLabel: "main", pr: { number: 479, url: "https://github.com/northwind/checkout-service/pull/479", title: "Move signing secrets" },
    };
    const review = { rawPatch: "diff --git a/a.ts b/a.ts\n", gitRef: "PR #479", source: { kind: "pr" as const, headSha: "old-head" } };
    saveFinishedGuide({
      repoKey,
      snapshot: buildGuideSnapshot({ guide: { title: "Move signing secrets to KMS", intent: "i", sections: [{ title: "s", overview: "o", diffs: [{ file: "a.ts" }] }], unplacedFiles: [] }, reviewed: [], review }),
      source,
      agent: { id: "claude-code", label: "Claude Code" },
      focus: {},
      now: 1000,
    });
    const draft = { ...createGuideDraft({ review }), chapters: [{ id: "c1", title: "x", overview: "y", files: [] }], nextChapter: 2 };
    saveDraftRecord({ v: 1, id: "draft-1-a", repoKey, createdAt: 2000, updatedAt: 2000, status: "stopped", source: { ...source, label: "Local changes", kind: "local", pr: undefined }, agent: { id: "claude-code", label: "Claude Code" }, draft });
    const runner = scripted([...gitRules, [/^gh api user/, ok("ramos")], [/^gh pr list/, ok(prList)], [/^gh search prs/, ok("[]")]]);
    const model = await loadDashboard(runner, "/repo/checkout-service");
    expect(model.recent.map((r) => [r.kind, r.title, r.moved ?? null])).toEqual([
      ["draft", "Draft · Local changes", null],
      ["guide", "Move signing secrets to KMS", true],
    ]);
  });
});

describe("pull request sources", () => {
  it("reads a PR number, #number or a URL of this repo only", () => {
    const repo = { github: { host: "github.com", owner: "northwind", repo: "checkout-service" } } as Parameters<typeof parsePullRequestRef>[1];
    expect(parsePullRequestRef("482", repo)).toBe(482);
    expect(parsePullRequestRef("#482", repo)).toBe(482);
    expect(parsePullRequestRef("https://github.com/northwind/checkout-service/pull/482/files", repo)).toBe(482);
    expect(parsePullRequestRef("https://github.com/other/repo/pull/482", repo)).toBeNull();
    expect(parsePullRequestRef("not a pr", repo)).toBeNull();
  });

  it("fetches the PR head, creates a detached worktree under the extension's storage, and diffs from the merge base", async () => {
    const calls: string[] = [];
    const storage = mkdtempSync(join(tmpdir(), "pn-guides-storage-"));
    const wtPath = join(storage, "worktrees", "key", "pr-482-headsha");
    let fetched = false;
    const runner = scripted([
      [/^git cat-file -e headsha\^\{commit\}/, () => (fetched ? ok("") : { code: 1, stdout: "", stderr: "" })],
      [/^git cat-file -e basesha\^\{commit\}/, ok("")],
      [/^git --no-pager fetch --no-tags --refmap= -- origin refs\/pull\/482\/head$/, () => ((fetched = true), ok(""))],
      [/^git --no-pager merge-base basesha headsha/, ok("mergebase\n")],
      [new RegExp(`^git --no-pager worktree add --force --detach -- ${wtPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} headsha$`), ok("")],
      [/^git --no-pager -c core.quotePath=false diff --no-ext-diff --no-color --src-prefix=a\/ --dst-prefix=b\/ mergebase headsha/, ok("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n")],
    ], calls);
    const repo = { root: "/repo", repoKey: "key" } as Parameters<typeof preparePullRequestWorktree>[1];
    const pr = { number: 482, title: "t", url: "u", body: "", author: "a", headRefName: "h", headRefOid: "headsha", baseRefName: "main", baseRefOid: "basesha" };
    const steps: string[] = [];
    const wt = await preparePullRequestWorktree(runner, repo, pr, storage, (s) => steps.push(s));
    expect(wt).toMatchObject({ path: wtPath, headSha: "headsha", mergeBase: "mergebase" });
    expect(wt.files).toEqual([{ path: "x.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ start: 1, end: 3 }] }]);
    expect(steps).toEqual(["Fetching PR #482", "Creating a worktree at the PR head"]);
    // Nothing touches the user's own checkout: no checkout, reset, or branch in the repo itself,
    // no `worktree prune` of their worktrees, and no fetch that could move one of their refs.
    expect(calls.some((c) => / (checkout|reset|switch|branch) /.test(c))).toBe(false);
    expect(calls.some((c) => /worktree prune/.test(c))).toBe(false);
    expect(calls.filter((c) => / fetch /.test(c)).every((c) => c.includes("--refmap= --"))).toBe(true);
  });
});
