/**
 * Starting a review (SPEC 3.2): a four-step Quick Pick. What (a PR or the
 * local changes), the agent (installed ones first; a missing one shows how to
 * install it), its model, then effort, plus "Add instructions for
 * this guide…" with the standing instructions shown. The models and efforts
 * are the agent's own, read from its ACP session config options.
 */

import * as vscode from "vscode";
import type { ConfigChoice } from "../acp/client";
import { pickDefault, type AgentDescriptor, type AgentOptionsCache, type AgentStatus } from "../acp/agents";
import type { DashboardModel } from "../dashboard";
import { parsePullRequestRef, type PullRequestRow } from "../sources/github";
import type { LocalChangesMode } from "../sources/git";
import type { AgentChoiceRecord } from "../store";

export type SourceChoice = { kind: "local"; mode: LocalChangesMode } | { kind: "pr"; number: number };

interface Item<T> extends vscode.QuickPickItem {
  value?: T;
}

function prDetail(p: PullRequestRow): string {
  const who = p.isMine ? "yours" : `@${p.author}`;
  return `${p.baseRefName} ← ${p.headRefName} · ${p.changedFiles} ${p.changedFiles === 1 ? "file" : "files"} · +${p.additions} −${p.deletions} · ${who}${p.isDraft ? " · draft" : ""}${p.reviewRequested ? " · waiting on you" : ""}`;
}

/** A Quick Pick that resolves to the accepted item, or the typed text when it matches `acceptValue`. */
function pick<T>(qp: vscode.QuickPick<Item<T>>, acceptValue?: (text: string) => T | undefined): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.dispose();
    };
    qp.onDidAccept(() => {
      const typed = acceptValue?.(qp.value);
      if (typed !== undefined && (qp.selectedItems.length === 0 || qp.value.trim() !== "")) return finish(typed);
      finish(qp.selectedItems[0]?.value);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

const PICK_PR = Symbol("pick-pr");

export async function pickSource(model: DashboardModel): Promise<SourceChoice | undefined> {
  if (!model.repo) {
    void vscode.window.showWarningMessage("Open a folder that is a git repository to start a guided review.");
    return undefined;
  }
  const qp = vscode.window.createQuickPick<Item<SourceChoice | typeof PICK_PR>>();
  qp.title = "New Guided Review";
  qp.step = 1;
  qp.totalSteps = 4;
  qp.placeholder = "What should the guide cover? (or type a PR number or link)";
  qp.matchOnDetail = true;
  const items: Array<Item<SourceChoice | typeof PICK_PR>> = [{ label: "This repository", kind: vscode.QuickPickItemKind.Separator }];
  const cur = model.currentBranchPR;
  if (cur) {
    items.push({ label: `$(git-pull-request) Pull request #${cur.number}`, description: cur.title, detail: prDetail(cur), value: { kind: "pr", number: cur.number } });
  }
  const local = model.local;
  if (local) {
    items.push({
      label: "$(git-compare) Local changes",
      description: `since ${local.baseLabel}`,
      detail: `${local.files} ${local.files === 1 ? "file" : "files"} · +${local.additions} −${local.deletions} · committed, uncommitted and untracked work`,
      value: { kind: "local", mode: "since-base" },
    });
    items.push({ label: "$(git-compare) Uncommitted changes only", description: "against HEAD", value: { kind: "local", mode: "uncommitted" } });
  }
  if (model.gh.state === "ok") {
    items.push({ label: "$(git-pull-request) Pull request…", description: `pick from ${model.prs.length} open, or paste a link`, detail: "GitHub via gh · no checkout needed: the PR opens in a worktree", value: PICK_PR });
  } else {
    items.push({ label: "$(info) Pull requests need the GitHub CLI", description: model.gh.state === "missing" ? "install gh" : model.gh.state === "signed-out" ? "run `gh auth login`" : "", detail: "Plannotator uses your own gh to list and fetch PRs." });
  }
  qp.items = items;
  if (cur) qp.activeItems = [items[1]];
  const choice = await pick(qp, (text) => {
    const n = parsePullRequestRef(text, model.repo ?? undefined);
    return n !== null ? ({ kind: "pr", number: n } as SourceChoice) : undefined;
  });
  if (choice === PICK_PR) return pickPullRequest(model);
  return choice as SourceChoice | undefined;
}

export async function pickPullRequest(model: DashboardModel): Promise<SourceChoice | undefined> {
  const qp = vscode.window.createQuickPick<Item<SourceChoice>>();
  qp.title = "New Guided Review: pull request";
  qp.step = 1;
  qp.totalSteps = 4;
  qp.placeholder = "Pick a PR, or paste its number or link";
  qp.matchOnDetail = true;
  qp.items = model.prs.map((p) => ({ label: `#${p.number} ${p.title}`, detail: prDetail(p), value: { kind: "pr", number: p.number } }));
  const choice = await pick(qp, (text) => {
    const n = parsePullRequestRef(text, model.repo ?? undefined);
    return n !== null ? ({ kind: "pr", number: n } as SourceChoice) : undefined;
  });
  return choice;
}

export interface AgentPickResult {
  agent: AgentChoiceRecord;
  instructions?: string;
  /** The user opted in to approving the agent's permission requests automatically for this run. */
  autoApprove?: boolean;
}

const LOAD_MODELS = Symbol("load-models");
const ADD_INSTRUCTIONS = Symbol("add-instructions");
const TOGGLE_APPROVE = Symbol("toggle-approve");

export interface RememberedChoice {
  agent?: string;
  model?: string;
  effort?: string;
}

/** The agent step's rows: installed agents first (the remembered one active), then the ones to install. Every installed agent can be picked. */
export function agentRows(agents: readonly AgentStatus[], remembered?: string): Array<{ status: AgentStatus; label: string; description: string; detail?: string; active: boolean }> {
  const rows = agents.map((status) => {
    const { agent, launch } = status;
    const installed = launch.ok;
    return {
      status,
      label: `${installed ? "$(check)" : "$(cloud-download)"} ${agent.label}`,
      description: installed
        ? [launch.source === "setting" ? "installed · command from settings" : "installed", agent.note ? "can't write guides yet" : ""].filter(Boolean).join(" · ")
        : agent.installCommand ? "not installed" : "not found",
      detail: agent.note ?? (installed ? "Runs with your own settings and permissions." : agent.installCommand ? `Install: ${agent.installCommand}` : launch.message),
      active: false,
    };
  });
  const firstInstalled = rows.find((r) => r.status.launch.ok);
  const target = rows.find((r) => r.status.agent.id === remembered && r.status.launch.ok) ?? firstInstalled;
  if (target) target.active = true;
  return rows;
}

/**
 * Steps 2 to 4: the agent, its model, then effort and instructions.
 * `loadOptions` asks an agent for its options when there are none cached yet;
 * `onMissing` is told when a missing agent is picked (show how to install it).
 */
export async function pickAgentAndEffort(input: {
  agents: readonly AgentStatus[];
  optionsFor: (agentId: string) => AgentOptionsCache | null;
  loadOptions: (agent: AgentDescriptor) => Promise<AgentOptionsCache | null>;
  onMissing: (status: AgentStatus) => Promise<void>;
  remembered?: RememberedChoice;
  standingInstructions: string;
  /** Only the defaults (the Change defaults command): no instructions step. */
  defaultsOnly?: boolean;
  /** Automatic approval preselected (the `plannotator.guides.autoApprove` setting). */
  autoApprove?: boolean;
}): Promise<AgentPickResult | undefined> {
  const title = input.defaultsOnly ? "Guide defaults" : "New Guided Review";
  const total = input.defaultsOnly ? 3 : 4;
  const offset = input.defaultsOnly ? 0 : 1;
  // Step: agent
  for (;;) {
    const aq = vscode.window.createQuickPick<Item<AgentStatus>>();
    aq.title = title;
    aq.step = 1 + offset;
    aq.totalSteps = total;
    aq.placeholder = "Which agent writes the guide? It runs with your own setup, settings and sign-in.";
    aq.matchOnDetail = true;
    const rows = agentRows(input.agents, input.remembered?.agent);
    const items: Array<Item<AgentStatus>> = [];
    const installed = rows.filter((r) => r.status.launch.ok);
    const missing = rows.filter((r) => !r.status.launch.ok);
    if (installed.length) items.push({ label: "Installed", kind: vscode.QuickPickItemKind.Separator });
    for (const r of installed) items.push({ label: r.label, description: r.description, detail: r.detail, value: r.status });
    if (missing.length) items.push({ label: "Not installed: pick one to see how to install it", kind: vscode.QuickPickItemKind.Separator });
    for (const r of missing) items.push({ label: r.label, description: r.description, detail: r.detail, value: r.status });
    aq.items = items;
    const active = items.find((i) => i.value && rows.find((r) => r.active)?.status === i.value);
    if (active) aq.activeItems = [active];
    const status = await pick(aq);
    if (!status) return undefined;
    if (!status.launch.ok) {
      await input.onMissing(status);
      continue;
    }
    const picked = await pickModelAndEffort({ ...input, agent: status.agent, title, total, offset, remembered: input.remembered?.agent === status.agent.id ? input.remembered : undefined });
    if (picked === BACK) continue;
    return picked;
  }
}

const BACK = Symbol("back");

async function pickModelAndEffort(input: {
  agent: AgentDescriptor;
  optionsFor: (agentId: string) => AgentOptionsCache | null;
  loadOptions: (agent: AgentDescriptor) => Promise<AgentOptionsCache | null>;
  remembered?: RememberedChoice;
  standingInstructions: string;
  defaultsOnly?: boolean;
  autoApprove?: boolean;
  title: string;
  total: number;
  offset: number;
}): Promise<AgentPickResult | undefined | typeof BACK> {
  const { agent } = input;
  let options = input.optionsFor(agent.id);
  let triedLoading = false;
  // Step: model
  for (;;) {
    const qp = vscode.window.createQuickPick<Item<ConfigChoice | null | typeof LOAD_MODELS | typeof BACK>>();
    qp.title = input.title;
    qp.step = 2 + input.offset;
    qp.totalSteps = input.total;
    qp.placeholder = `Which ${agent.label} model writes the guide?`;
    if (!options && !triedLoading) {
      // First time: the agent lists its own models (nothing is prompted, no cost); cached afterwards.
      triedLoading = true;
      qp.busy = true;
      qp.enabled = false;
      qp.placeholder = `Asking ${agent.label} for its models…`;
      let hidden = false;
      const off = qp.onDidHide(() => (hidden = true));
      qp.show();
      options = await input.loadOptions(agent);
      off.dispose();
      if (hidden) {
        qp.dispose();
        return undefined;
      }
      qp.busy = false;
      qp.enabled = true;
      qp.placeholder = `Which ${agent.label} model writes the guide?`;
    }
    const items: Array<Item<ConfigChoice | null | typeof LOAD_MODELS | typeof BACK>> = [{ label: agent.label, kind: vscode.QuickPickItemKind.Separator }];
    const models = options?.model;
    const preferred = pickDefault(models ?? null, agent.defaultModel, input.remembered?.model);
    if (models && models.options.length > 0) {
      for (const m of models.options) {
        items.push({
          label: `$(sparkle) ${m.name}`,
          description: [m.value === preferred?.value ? "default" : "", m.value === models.current ? "agent's current" : ""].filter(Boolean).join(" · "),
          detail: m.description,
          value: m,
        });
      }
    } else {
      items.push({ label: "$(sparkle) Agent default", description: options ? `${agent.label} exposes no model choice` : "", value: null });
    }
    if (!options) items.push({ label: `$(refresh) Load the models from ${agent.label}`, detail: `Starts ${agent.label} once to read its options (nothing runs, no cost).`, value: LOAD_MODELS });
    items.push({ label: "$(arrow-left) Another agent", value: BACK, alwaysShow: true });
    qp.items = items;
    const active = items.find((i) => i.value && typeof i.value === "object" && preferred && i.value.value === preferred.value);
    if (active) qp.activeItems = [active];
    const chosen = await pick(qp);
    if (chosen === undefined) return undefined;
    if (chosen === BACK) return BACK;
    if (chosen === LOAD_MODELS) {
      options = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Asking ${agent.label} for its models…` }, () => input.loadOptions(agent));
      continue;
    }
    const model = chosen as ConfigChoice | null;
    // Step: effort (+ instructions)
    let instructions = input.standingInstructions || undefined;
    let added = false;
    let autoApprove = !!input.autoApprove;
    for (;;) {
      const eq = vscode.window.createQuickPick<Item<ConfigChoice | null | typeof ADD_INSTRUCTIONS | typeof TOGGLE_APPROVE>>();
      eq.title = input.title;
      eq.step = 3 + input.offset;
      eq.totalSteps = input.total;
      eq.placeholder = `Effort for ${model?.name ?? "the agent's default model"}`;
      const efforts = options?.effortByModel?.[model?.value ?? ""] ?? options?.effort ?? null;
      const preferredEffort = pickDefault(efforts, agent.defaultEffort, input.remembered?.effort);
      const eItems: Array<Item<ConfigChoice | null | typeof ADD_INSTRUCTIONS | typeof TOGGLE_APPROVE>> = [];
      if (efforts && efforts.options.length) {
        for (const e of efforts.options) eItems.push({ label: e.name, description: e.value === preferredEffort?.value ? "default" : "", detail: e.description, value: e });
      } else eItems.push({ label: "Agent default", description: "this model has no effort levels", value: null });
      if (!input.defaultsOnly) {
        eItems.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        eItems.push({
          label: added ? "$(check) Instructions for this guide" : "$(edit) Add instructions for this guide…",
          description: instructions ? "" : "optional",
          detail: instructions ? `${added ? "" : "Standing instructions: "}${instructions.replace(/\s+/g, " ").slice(0, 110)}` : "Standing instructions: none (set them in Plannotator's web app)",
          value: ADD_INSTRUCTIONS,
          alwaysShow: true,
        });
        eItems.push({
          label: autoApprove ? "$(unlock) Approve the agent's requests automatically: on" : "$(lock) Approve the agent's requests automatically: off",
          description: autoApprove ? "this run" : "you approve each request",
          detail: autoApprove
            ? `Every permission request ${agent.label} sends is approved for you during this guide${agent.permissiveModes?.length ? `, and it runs in its ${agent.permissiveModes[0]} mode` : ""}. Pick to turn off.`
            : `Off: ${agent.label} runs with your own settings and you answer what it asks about. Pick to turn on for this guide.`,
          value: TOGGLE_APPROVE,
          alwaysShow: true,
        });
      }
      eq.items = eItems;
      const activeEffort = eItems.find((i) => i.value && typeof i.value === "object" && preferredEffort && i.value.value === preferredEffort.value);
      if (activeEffort) eq.activeItems = [activeEffort];
      const effortChoice = await pick(eq);
      if (effortChoice === undefined) return undefined;
      if (effortChoice === TOGGLE_APPROVE) {
        autoApprove = !autoApprove;
        continue;
      }
      if (effortChoice === ADD_INSTRUCTIONS) {
        const text = await vscode.window.showInputBox({
          title: "Instructions for this guide",
          prompt: "Appended to the guide prompt. Prefilled with your standing instructions.",
          value: instructions ?? "",
          ignoreFocusOut: true,
        });
        if (text !== undefined) {
          instructions = text.trim() || undefined;
          added = true;
        }
        continue;
      }
      const effort = effortChoice as ConfigChoice | null;
      return {
        agent: {
          id: agent.id,
          label: agent.label,
          ...(model && { model: { id: model.value, label: model.name } }),
          ...(effort && { effort: { id: effort.value, label: effort.name } }),
        },
        ...(instructions && { instructions }),
        ...(autoApprove && { autoApprove: true }),
      };
    }
  }
}
