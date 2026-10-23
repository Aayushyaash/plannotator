/**
 * Which agents can write a guide, and how to start them over ACP.
 *
 * A small, bundled list: every entry's launch command and install command come
 * from the agent's own documentation (the source is linked on each entry), and
 * the extension never installs or downloads anything itself (no `npx`, no
 * registry fetch at runtime). Any other ACP agent can be started with the
 * custom agent settings.
 *
 * Guides runs the agent with the user's own configuration and permissions,
 * exactly as they set it up: no mode is forced, no tool is added or removed,
 * no setting source is narrowed. What the agent may do is governed by its own
 * settings; every permission request it sends is shown to the user with all
 * of its options. Guides adds only what a guide needs: its own MCP server (the
 * builder tools), the model and effort the user picked, and the prompt.
 */

import { findExecutable } from "../sources/runner";
import { readEffortSelect, readModelSelect, type ConfigChoice, type ConfigSelect } from "./client";
import type { AuthMethod, SessionConfigOption } from "@agentclientprotocol/sdk";

export interface AgentDescriptor {
  id: string;
  label: string;
  /** `generator.engine` in a saved guide. */
  engine: string;
  /** The program on PATH. */
  command: string;
  /** Other names the same program is installed under, tried in order after `command`. */
  altCommands?: readonly string[];
  /** Arguments that start its ACP server on stdio. */
  args: readonly string[];
  /** How to install it, as the agent's docs say. */
  installCommand: string;
  docsUrl: string;
  /** Cheap defaults: matched against the agent's own option values and names. */
  defaultModel?: RegExp;
  defaultEffort?: RegExp;
  /**
   * The agent's own modes that let it act without asking, in order of
   * preference. Used only when the user opts in to automatic approval;
   * otherwise the session stays in whatever mode the user's config starts it in.
   */
  permissiveModes?: readonly string[];
  /**
   * A known capability gap, shown in the picker. It never stops the agent from
   * being picked or started.
   */
  note?: string;
  /** Sign in in a terminal when the agent lists no terminal sign-in of its own. */
  signIn?: { command: string; args: readonly string[] };
}

/** Claude Code through its ACP adapter. Source: https://github.com/agentclientprotocol/claude-agent-acp */
export const CLAUDE_CODE: AgentDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  engine: "claude",
  command: "claude-agent-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/claude-agent-acp",
  docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
  defaultModel: /sonnet/i,
  defaultEffort: /^low$/i,
  permissiveModes: ["acceptEdits"],
  signIn: { command: "claude", args: ["/login"] },
};

/** Codex through `codex-acp`. Source: https://github.com/agentclientprotocol/codex-acp */
export const CODEX: AgentDescriptor = {
  id: "codex",
  label: "Codex",
  engine: "codex",
  command: "codex-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/codex-acp",
  docsUrl: "https://github.com/agentclientprotocol/codex-acp",
  defaultEffort: /^low$/i,
  // codex-acp's `agent` mode ("Auto review") writes in the workspace without asking; `read-only` asks first.
  permissiveModes: ["agent"],
};

/** OpenCode's `opencode acp`. Source: https://opencode.ai/docs/acp/ */
export const OPENCODE: AgentDescriptor = {
  id: "opencode",
  label: "OpenCode",
  engine: "opencode",
  command: "opencode",
  args: ["acp"],
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  docsUrl: "https://opencode.ai/docs/acp/",
  signIn: { command: "opencode", args: ["auth", "login"] },
};

/** GitHub Copilot CLI's ACP server. Source: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server */
export const COPILOT: AgentDescriptor = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  engine: "copilot",
  command: "copilot",
  args: ["--acp", "--stdio"],
  installCommand: "npm install -g @github/copilot",
  docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
  defaultEffort: /^low$/i,
};

/**
 * Cursor's CLI in ACP mode. Source: https://cursor.com/docs/cli/acp (`agent
 * acp`); the ACP registry starts the same program as `cursor-agent acp`.
 */
export const CURSOR: AgentDescriptor = {
  id: "cursor",
  label: "Cursor",
  engine: "cursor",
  command: "cursor-agent",
  altCommands: ["agent"],
  args: ["acp"],
  installCommand: "curl https://cursor.com/install -fsS | bash",
  docsUrl: "https://cursor.com/docs/cli/acp",
  signIn: { command: "agent", args: ["login"] },
};

/** Kiro CLI's ACP server. Source: https://kiro.dev/docs/cli/acp/ */
export const KIRO: AgentDescriptor = {
  id: "kiro",
  label: "Kiro CLI",
  engine: "kiro",
  command: "kiro-cli",
  args: ["acp"],
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  docsUrl: "https://kiro.dev/docs/cli/acp/",
};

/**
 * Kilo Code's CLI. Sources: https://kilo.ai/docs and Kilo-Org/kilocode
 * (`packages/opencode/src/cli/cmd/acp.ts`); the npm package `@kilocode/cli`
 * installs `kilo` and `kilocode`.
 */
export const KILO: AgentDescriptor = {
  id: "kilo",
  label: "Kilo Code",
  engine: "kilo",
  command: "kilo",
  altCommands: ["kilocode"],
  args: ["acp"],
  installCommand: "npm install -g @kilocode/cli",
  docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
  signIn: { command: "kilo", args: ["auth", "login"] },
};

/**
 * Pi through `pi-acp`. Source: https://github.com/svkozak/pi-acp (README:
 * "MCP servers are accepted in ACP params and stored in session state, but
 * not wired through to pi"). Pi can be picked and started like any agent, but
 * until pi-acp passes MCP servers on it cannot reach the guide's tools.
 */
export const PI: AgentDescriptor = {
  id: "pi",
  label: "Pi",
  engine: "pi",
  command: "pi-acp",
  args: [],
  installCommand: "npm install -g pi-acp",
  docsUrl: "https://github.com/svkozak/pi-acp",
  note: "Can't write guides yet: pi-acp does not pass MCP servers on to Pi (its README says they are \"accepted … but not wired through to pi\"), so Pi cannot reach the guide's tools.",
};

/** The known agents, in the order the picker lists them (installed ones first). */
export const KNOWN_AGENTS: readonly AgentDescriptor[] = [CLAUDE_CODE, CODEX, OPENCODE, COPILOT, CURSOR, KIRO, KILO, PI];

export const CUSTOM_AGENT_ID = "custom";

/** The custom agent from settings: any other ACP agent. */
export function customAgent(setting: { command?: string; args?: string[]; label?: string }): AgentDescriptor | null {
  const command = setting.command?.trim();
  if (!command) return null;
  return {
    id: CUSTOM_AGENT_ID,
    label: setting.label?.trim() || "Custom agent",
    engine: "acp",
    command,
    args: setting.args ?? [],
    installCommand: "",
    docsUrl: "https://agentclientprotocol.com/get-started/agents",
  };
}

export function findAgent(id: string, custom: AgentDescriptor | null): AgentDescriptor | null {
  if (id === CUSTOM_AGENT_ID) return custom;
  return KNOWN_AGENTS.find((a) => a.id === id) ?? null;
}

/** The label for a saved guide's `engine` ("claude" → "Claude Code"). */
export function engineLabel(engine: string | undefined): string {
  if (!engine) return "";
  return KNOWN_AGENTS.find((a) => a.engine === engine)?.label ?? engine;
}

export type AdapterResolution =
  | { ok: true; command: string; args: string[]; source: "setting" | "path" }
  | { ok: false; message: string };

/** A command override from settings: replaces the program and, when given, its arguments. */
export interface CommandOverride {
  command?: string;
  args?: string[];
}

/**
 * The command to start: the override when it names a program (its args, else
 * the agent's own), else the agent's program on PATH (or one of its other
 * names). The same for a local run and a pull request run.
 */
export function resolveAgentLaunch(agent: AgentDescriptor, override: CommandOverride = {}, find: (name: string) => string | null = findExecutable): AdapterResolution {
  const configured = override.command?.trim();
  if (configured) {
    const found = find(configured);
    if (!found) return { ok: false, message: `The configured command for ${agent.label}, \`${configured}\`, was not found.` };
    const args = override.args && override.args.length > 0 ? override.args : [...agent.args];
    return { ok: true, command: found, args, source: "setting" };
  }
  for (const name of [agent.command, ...(agent.altCommands ?? [])]) {
    const found = find(name);
    if (found) return { ok: true, command: found, args: [...agent.args], source: "path" };
  }
  return {
    ok: false,
    message: agent.installCommand
      ? `${agent.label} is not installed: \`${agent.command}\` is not on PATH. Install it with \`${agent.installCommand}\`, then try again.`
      : `\`${agent.command}\` is not on PATH.`,
  };
}

/** An agent as the picker shows it. */
export interface AgentStatus {
  agent: AgentDescriptor;
  launch: AdapterResolution;
}

/** Every known agent (and the custom one when set), installed ones first, each group in the list's order. */
export function detectAgents(overrides: (id: string) => CommandOverride, custom: AgentDescriptor | null, find: (name: string) => string | null = findExecutable): AgentStatus[] {
  const all = [...KNOWN_AGENTS, ...(custom ? [custom] : [])].map((agent) => ({ agent, launch: resolveAgentLaunch(agent, agent.id === CUSTOM_AGENT_ID ? {} : overrides(agent.id), find) }));
  return [...all.filter((s) => s.launch.ok), ...all.filter((s) => !s.launch.ok)];
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
    model: readModelSelect(configOptions),
    effort: readEffortSelect(configOptions),
  };
}

/** The choice to preselect: the remembered value if it is still offered, else the cheap default, else the agent's current. */
export function pickDefault(select: ConfigSelect | null, pattern: RegExp | undefined, remembered?: string): ConfigChoice | null {
  if (!select || select.options.length === 0) return null;
  if (remembered) {
    const hit = select.options.find((o) => o.value === remembered);
    if (hit) return hit;
  }
  const byPattern = pattern ? select.options.find((o) => pattern.test(o.value) || pattern.test(o.name)) : undefined;
  return byPattern ?? select.options.find((o) => o.value === select.current) ?? select.options[0];
}

/** A sign-in the agent offers: run the agent's own command with these args in a terminal. */
export interface LoginCommand {
  label: string;
  description?: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The terminal sign-ins the agent advertised in `initialize` (ACP terminal
 * auth: run the agent's command with `args`). Empty when it offered none.
 */
export function loginCommands(authMethods: readonly AuthMethod[] | null | undefined): LoginCommand[] {
  const out: LoginCommand[] = [];
  for (const m of authMethods ?? []) {
    if (!("type" in m) || m.type !== "terminal") continue;
    const t = m as { name: string; description?: string | null; args?: string[]; env?: Record<string, string> };
    if (!Array.isArray(t.args) || !t.args.every((a) => typeof a === "string")) continue;
    out.push({ label: t.name, ...(t.description && { description: t.description }), args: t.args, ...(t.env && { env: t.env }) });
  }
  return out;
}
