/**
 * The start flow's automatic-approval toggle, through a scripted Quick Pick
 * on the vscode mock (each step picks the first item whose label matches).
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { CLAUDE_CODE, type AgentOptionsCache, type AgentStatus } from "../acp/agents";
import { autoApproveChoice, pickAgentAndEffort } from "./new-review";

type Item = { label: string; kind?: number };

function scriptQuickPicks(steps: Array<RegExp>): { seen: string[][] } {
  const seen: string[][] = [];
  (vscode.window as unknown as Record<string, unknown>).createQuickPick = () => {
    const accept: Array<() => void> = [];
    const qp = {
      items: [] as Item[],
      activeItems: [] as Item[],
      selectedItems: [] as Item[],
      value: "",
      title: "", step: 0, totalSteps: 0, placeholder: "", busy: false, enabled: true, matchOnDetail: false,
      onDidAccept: (cb: () => void) => { accept.push(cb); return { dispose() {} }; },
      onDidHide: () => ({ dispose() {} }),
      show() {
        queueMicrotask(() => {
          const want = steps.shift();
          if (!want) throw new Error("no scripted step left");
          seen.push(qp.items.map((i) => i.label));
          const item = qp.items.find((i) => i.kind !== -1 && want.test(i.label));
          if (!item) throw new Error(`no item matches ${want}: ${qp.items.map((i) => i.label).join(" | ")}`);
          qp.selectedItems = [item];
          for (const cb of accept) cb();
        });
      },
      dispose() {},
    };
    return qp;
  };
  return { seen };
}

const options: AgentOptionsCache = {
  agentId: "claude-code",
  fetchedAt: Date.now(),
  model: { configId: "model", name: "Model", current: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
  effort: { configId: "effort", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
};
const agents: AgentStatus[] = [{ agent: CLAUDE_CODE, launch: { ok: true, command: "/bin/claude-agent-acp", args: [], source: "path" } }];
const input = (autoApprove: boolean) => ({
  agents,
  optionsFor: () => options,
  loadOptions: async () => options,
  onMissing: async () => null,
  standingInstructions: "",
  autoApprove,
});

afterEach(() => {
  delete (vscode.window as unknown as Record<string, unknown>).createQuickPick;
});

describe("the start flow's automatic approval", () => {
  it("turns on for this run when the toggle is picked with the setting off", async () => {
    const { seen } = scriptQuickPicks([/Claude Code/, /Sonnet/, /requests automatically: off/, /^Low$/]);
    const picked = await pickAgentAndEffort(input(false));
    expect(picked?.autoApprove).toBe(true);
    expect(autoApproveChoice(picked!)).toBe(true);
    expect(seen[3]).toContain("$(unlock) Approve the agent's requests automatically: on");
  });

  it("turns off for this run when the toggle is picked with the setting on", async () => {
    scriptQuickPicks([/Claude Code/, /Sonnet/, /requests automatically: on/, /^Low$/]);
    const picked = await pickAgentAndEffort(input(true));
    expect(picked?.autoApprove).toBeUndefined();
    expect(autoApproveChoice(picked!)).toBe(false);
  });

  it("keeps the setting's value when the toggle is left alone", async () => {
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    expect(autoApproveChoice((await pickAgentAndEffort(input(true)))!)).toBe(true);
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    expect(autoApproveChoice((await pickAgentAndEffort(input(false)))!)).toBe(false);
  });
});
