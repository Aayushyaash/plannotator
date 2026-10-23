/**
 * Which agents can write a guide, and how to start them. Phase 1: Claude Code
 * through its ACP adapter (`claude-agent-acp`). The extension detects the
 * adapter and shows how to install it; it never installs anything itself.
 */

import { findExecutable } from "../sources/runner";
import { readConfigSelect, type ConfigChoice, type ConfigSelect } from "./client";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export interface AgentDescriptor {
  id: "claude-code";
  label: string;
  adapterBinary: string;
  installCommand: string;
  docsUrl: string;
  /** Cheap defaults (SPEC 3.2): matched against the agent's own option names and values. */
  defaultModel: RegExp;
  defaultEffort: RegExp;
}

export const CLAUDE_CODE: AgentDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  adapterBinary: "claude-agent-acp",
  installCommand: "npm install -g @agentclientprotocol/claude-agent-acp",
  docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
  defaultModel: /sonnet/i,
  defaultEffort: /^low$/i,
};

export type AdapterResolution =
  | { ok: true; command: string; args: string[]; source: "setting" | "path" }
  | { ok: false; message: string };

/**
 * The adapter to start: the `plannotator.guides.claudeCode.command` setting
 * when set (with its args), else `claude-agent-acp` on PATH.
 */
export function resolveAgentLaunch(agent: AgentDescriptor, setting: { command?: string; args?: string[] }): AdapterResolution {
  const configured = setting.command?.trim();
  if (configured) {
    const found = findExecutable(configured);
    if (!found) return { ok: false, message: `The configured adapter \`${configured}\` was not found.` };
    return { ok: true, command: found, args: setting.args ?? [], source: "setting" };
  }
  const found = findExecutable(agent.adapterBinary);
  if (!found) {
    return {
      ok: false,
      message: `${agent.label} needs its ACP adapter, \`${agent.adapterBinary}\`, which is not on PATH. Install it with \`${agent.installCommand}\`, then try again.`,
    };
  }
  return { ok: true, command: found, args: [], source: "path" };
}

export interface AgentOptionsCache {
  agentId: string;
  fetchedAt: number;
  model: ConfigSelect | null;
  effort: ConfigSelect | null;
  /** Efforts per model value, when the agent's effort list depends on the model. */
  effortByModel?: Record<string, ConfigSelect | null>;
}

export function readAgentOptions(agentId: string, configOptions: readonly SessionConfigOption[] | null | undefined, now = Date.now()): AgentOptionsCache {
  return {
    agentId,
    fetchedAt: now,
    model: readConfigSelect(configOptions, "model"),
    effort: readConfigSelect(configOptions, "thought_level"),
  };
}

/** The choice to preselect: the remembered value if it is still offered, else the cheap default, else the agent's current. */
export function pickDefault(select: ConfigSelect | null, pattern: RegExp, remembered?: string): ConfigChoice | null {
  if (!select || select.options.length === 0) return null;
  if (remembered) {
    const hit = select.options.find((o) => o.value === remembered);
    if (hit) return hit;
  }
  const byPattern = select.options.find((o) => pattern.test(o.value) || pattern.test(o.name));
  return byPattern ?? select.options.find((o) => o.value === select.current) ?? select.options[0];
}
