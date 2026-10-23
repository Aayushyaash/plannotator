/**
 * Which agents can write a guide, and how to start them over ACP.
 *
 * A small, bundled list: every entry's launch command and install command come
 * from the agent's own documentation (the source is linked on each entry), and
 * the extension never installs or downloads anything itself (no `npx`, no
 * registry fetch at runtime). Any other ACP agent can be started with the
 * custom agent settings.
 *
 * Read-only enforcement has two layers. Every agent runs under the client's
 * permission policy (`permission-policy.ts`: edits, deletes, moves, commands
 * and mode switches are refused; the client offers no file system or
 * terminal) and the write tripwire in `generation.ts` (a tool call that edits
 * files and completes stops the run). Those only bind an agent that asks
 * before it writes, so where an agent has its own switch that forbids writes
 * (a read-only sandbox, a plan mode, a deny rule), the entry turns it on too:
 * `readOnly` below. An entry whose `readOnly.layer` is "permissions" has no
 * such switch Guides could verify; it is as read-only as its own default
 * permission settings, plus the tripwire.
 */

import { findExecutable } from "../sources/runner";
import { readEffortSelect, readModelSelect, type ConfigChoice, type ConfigSelect } from "./client";
import type { RunKind } from "./permission-policy";
import type { AuthMethod, SessionConfigOption } from "@agentclientprotocol/sdk";

export interface ReadOnlyEnforcement {
  /**
   * "agent": the agent's own switch forbids writes (below), on top of the
   * permission policy. "permissions": only the permission policy and the
   * tripwire.
   */
  layer: "agent" | "permissions";
  /** One plain sentence: what keeps this agent from writing. */
  summary: string;
  /** Arguments added to the launch after the agent's own (flags that forbid writes). */
  args?: readonly string[];
  /** Environment added to the launch. */
  env?: Readonly<Record<string, string>>;
  /** Environment added for a pull request run only (turn off the PR's own project config). */
  prEnv?: Readonly<Record<string, string>>;
  /** `_meta` for `session/new`, per run. */
  sessionMeta?(run: RunKind): Record<string, unknown> | undefined;
  /**
   * A session mode to be in before the first prompt: the first of `ids` the
   * agent offers, through its `mode` config option, else `session/set_mode`.
   * When the session already is in one of them nothing changes. When none can
   * be set, the run fails and nothing is prompted.
   */
  mode?: { ids: readonly string[]; label: string };
}

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
  readOnly: ReadOnlyEnforcement;
  /**
   * Why a pull request is not offered to this agent (its adapter would load
   * the PR's own project config, which can start programs). Local changes only.
   */
  refusePullRequests?: string;
  /** Said in the activity when a pull request run starts: a risk Guides could not rule out. */
  prNote?: string;
  /** Why this agent cannot write a guide at all yet: shown, never started. */
  unsupported?: string;
  /** Sign in in a terminal when the agent lists no terminal sign-in of its own. */
  signIn?: { command: string; args: readonly string[] };
}

/** Claude Code's file-writing tools, refused by the adapter itself on every run (`disallowedTools`). */
const CLAUDE_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * Claude Code through its ACP adapter. Source: the adapter's README and
 * `src/acp-agent.ts`, https://github.com/agentclientprotocol/claude-agent-acp.
 * A pull request is someone else's code: its worktree may carry
 * `.claude/settings.json` hooks, allow rules and MCP servers, and a
 * `.mcp.json`, which Claude Code would load and run under the reviewer's
 * account (hooks need no prompt). The adapter reads `_meta.claudeCode.options`
 * and spreads it over its own options, so a PR run loads the user's settings
 * only and no MCP server but the ones we pass, and adapters that read
 * `allowDangerouslySkipPermissions` refuse bypass. Every run also adds
 * Claude Code's write tools to `disallowedTools` (merged with the adapter's
 * own list). The adapter still starts the session in the cwd's
 * `permissions.defaultMode` (`acceptEdits` or `bypassPermissions` would edit
 * without asking), so every run is set back to `default`, which asks before an
 * edit (and the permission policy refuses it).
 */
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
  readOnly: {
    layer: "agent",
    summary: "Runs in Claude Code's default permission mode with its edit and write tools disallowed; a pull request also loads only your user settings and no MCP server of its own.",
    sessionMeta: (run) => ({
      claudeCode: {
        options:
          run === "pr"
            ? { settingSources: ["user"], strictMcpConfig: true, allowDangerouslySkipPermissions: false, disallowedTools: CLAUDE_WRITE_TOOLS }
            : { disallowedTools: CLAUDE_WRITE_TOOLS },
      },
    }),
    mode: { ids: ["default"], label: "the default permission mode" },
  },
  signIn: { command: "claude", args: ["/login"] },
};

/**
 * Codex through `codex-acp`. Source: https://github.com/agentclientprotocol/codex-acp
 * (README; `src/AgentMode.ts`: the `read-only` mode is a read-only sandbox
 * that asks before edits and network; `INITIAL_AGENT_MODE` sets the starting
 * mode). Its default mode, `agent`, writes in the workspace without asking.
 * Pull requests are refused: codex-acp marks every session folder trusted
 * (`CodexAcpClient.ts`), so a PR's own `.codex/` config (MCP servers, hooks,
 * rules) would load.
 */
export const CODEX: AgentDescriptor = {
  id: "codex",
  label: "Codex",
  engine: "codex",
  command: "codex-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/codex-acp",
  docsUrl: "https://github.com/agentclientprotocol/codex-acp",
  defaultEffort: /^low$/i,
  readOnly: {
    layer: "agent",
    summary: "Runs in codex-acp's read-only mode: a read-only sandbox that asks before edits and network access.",
    env: { INITIAL_AGENT_MODE: "read-only" },
    mode: { ids: ["read-only"], label: "its read-only mode" },
  },
  refusePullRequests: "codex-acp trusts the folder it runs in, so a pull request's own .codex/ config (MCP servers, hooks) would load and run. Guides runs Codex on local changes only.",
};

/**
 * OpenCode's `opencode acp`. Sources: https://opencode.ai/docs/acp/ and the
 * source (`packages/core/src/config.ts`, `config/plugin/agent.ts`,
 * `plugin/plan.ts`, `cli/src/server-process.ts` in anomalyco/opencode).
 * OpenCode's default permissions let edits and shell run without asking, and
 * the `plan` mode still lets shell commands run. Guides passes
 * `OPENCODE_CONFIG_CONTENT` (it loads after the project's config; config
 * permission rules apply to every agent, last match wins) denying edits and
 * shell and asking before web fetches, and runs in `plan`. A pull request
 * also gets `OPENCODE_DISABLE_PROJECT_CONFIG` (no `opencode.json` or
 * `.opencode/` from the PR, so no per-agent rules that would come after ours)
 * and `OPENCODE_DISABLE_CLAUDE_CODE`. Read from source, not tested live.
 */
export const OPENCODE: AgentDescriptor = {
  id: "opencode",
  label: "OpenCode",
  engine: "opencode",
  command: "opencode",
  args: ["acp"],
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  docsUrl: "https://opencode.ai/docs/acp/",
  readOnly: {
    layer: "agent",
    summary: "Runs in OpenCode's plan mode with an added config that denies edits and shell commands; a pull request also skips the PR's own OpenCode config.",
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "deny", bash: "deny", webfetch: "ask" } }) },
    prEnv: { OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    mode: { ids: ["plan"], label: "its plan mode" },
  },
  signIn: { command: "opencode", args: ["auth", "login"] },
};

/**
 * Pi through `pi-acp`. Source: https://github.com/svkozak/pi-acp (README:
 * "MCP servers are accepted in ACP params and stored in session state, but
 * not wired through to pi"; `src/acp/agent.ts` never sends
 * `session/request_permission`). Without MCP servers Pi cannot reach the
 * guide's builder tools, so it is listed but not started.
 */
export const PI: AgentDescriptor = {
  id: "pi",
  label: "Pi",
  engine: "pi",
  command: "pi-acp",
  args: [],
  installCommand: "npm install -g pi-acp",
  docsUrl: "https://github.com/svkozak/pi-acp",
  readOnly: {
    layer: "permissions",
    summary: "None: pi-acp never asks before Pi edits or runs commands.",
  },
  unsupported: "pi-acp does not pass MCP servers to Pi, so Pi cannot call the guide's tools; and Pi never asks before it edits files or runs commands. Guides cannot run Pi until pi-acp passes MCP servers through.",
};

/**
 * GitHub Copilot CLI's ACP server. Source:
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
 * (`copilot --acp --stdio`). It asks the client before edits and commands
 * (copilot-cli issue #845, fixed in early 2026). Its tool-restriction flags
 * (`--excluded-tools`) take tool names the docs do not list, so Guides relies on
 * the permission policy only. Whether it passes the client's MCP servers on
 * is not documented.
 */
export const COPILOT: AgentDescriptor = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  engine: "copilot",
  command: "copilot",
  args: ["--acp", "--stdio"],
  installCommand: "npm install -g @github/copilot",
  docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
  defaultEffort: /^low$/i,
  readOnly: {
    layer: "permissions",
    summary: "Copilot asks before it edits files or runs commands, and Guides refuses them.",
  },
};

/**
 * Cursor's CLI in ACP mode. Source: https://cursor.com/docs/cli/acp (`agent
 * acp`; modes `agent`, `plan` "planning, read-only behavior" and `ask`
 * "Q&A/read-only behavior"; permissions through `session/request_permission`).
 * The ACP registry starts the same program as `cursor-agent acp`. A project's
 * `.cursor/cli.json` can carry permission allow rules, and Cursor offers no
 * switch to ignore it.
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
  readOnly: {
    layer: "agent",
    summary: "Runs in Cursor's ask mode (read-only Q&A); edits and commands it asks about are refused.",
    mode: { ids: ["ask", "plan"], label: "its ask or plan mode" },
  },
  prNote: "Cursor reads the pull request's own .cursor/cli.json, which can allow commands without asking; Guides cannot turn that off for Cursor.",
  signIn: { command: "agent", args: ["login"] },
};

/**
 * Kiro CLI's ACP server. Source: https://kiro.dev/docs/cli/acp/ (`kiro-cli
 * acp`; MCP servers can be passed to ACP sessions) and
 * https://kiro.dev/docs/permissions/ (reads workspace files and read-only
 * git and system commands without asking; everything else prompts).
 */
export const KIRO: AgentDescriptor = {
  id: "kiro",
  label: "Kiro CLI",
  engine: "kiro",
  command: "kiro-cli",
  args: ["acp"],
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  docsUrl: "https://kiro.dev/docs/cli/acp/",
  readOnly: {
    layer: "permissions",
    summary: "Kiro asks before edits and commands other than read-only git and system queries, and Guides refuses them.",
  },
  prNote: "Whether Kiro's workspace-trust gate (which keeps a new workspace's agents, MCP servers and skills from loading) applies to ACP sessions is not documented.",
};

/**
 * Kilo Code's CLI (an OpenCode fork). Sources: https://kilo.ai/docs and the
 * source (`packages/opencode/src/cli/cmd/acp.ts`, `kilocode/agent/index.ts`,
 * `config/paths.ts`, `core/src/flag/flag.ts` in Kilo-Org/kilocode); the npm
 * package `@kilocode/cli` installs `kilo` and `kilocode`. Its `ask` mode
 * denies edits, writes and shell commands other than read-only ones, and
 * config cannot widen it except per agent, which a pull request cannot set
 * with `KILO_DISABLE_PROJECT_CONFIG`. Its default `code` mode edits without
 * asking.
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
  readOnly: {
    layer: "agent",
    summary: "Runs in Kilo's ask mode, which denies edits and shell commands other than read-only ones; a pull request also skips the PR's own Kilo config.",
    prEnv: { KILO_DISABLE_PROJECT_CONFIG: "1", KILO_DISABLE_EXTERNAL_SKILLS: "1", KILO_DISABLE_CLAUDE_CODE: "1" },
    mode: { ids: ["ask"], label: "its ask mode" },
  },
  signIn: { command: "kilo", args: ["auth", "login"] },
};

/** The known agents, in the order the picker lists them (installed ones first). */
export const KNOWN_AGENTS: readonly AgentDescriptor[] = [CLAUDE_CODE, CODEX, OPENCODE, COPILOT, CURSOR, KIRO, KILO, PI];

export const CUSTOM_AGENT_ID = "custom";

/** The custom agent from settings: any ACP agent, under the permission policy only. */
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
    readOnly: {
      layer: "permissions",
      summary: "Only the permission policy: Guides refuses its edits, deletes, moves and commands when it asks; an agent that writes without asking is stopped when Guides sees it.",
    },
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
  | { ok: true; command: string; args: string[]; env?: Record<string, string>; source: "setting" | "path" }
  | { ok: false; message: string };

/** A command override from settings: replaces the program and, when given, its arguments. */
export interface CommandOverride {
  command?: string;
  args?: string[];
}

/**
 * The command to start: the override when it names a program (its args, else
 * the agent's own), else the agent's program on PATH (or one of its other
 * names). The read-only arguments and environment are always added, whatever
 * starts it, and a pull request run adds `prEnv`.
 */
export function resolveAgentLaunch(agent: AgentDescriptor, override: CommandOverride = {}, run: RunKind = "local", find: (name: string) => string | null = findExecutable): AdapterResolution {
  if (agent.unsupported) return { ok: false, message: `${agent.label}: ${agent.unsupported}` };
  const extraArgs = [...(agent.readOnly.args ?? [])];
  const envEntries = { ...(agent.readOnly.env ?? {}), ...(run === "pr" ? agent.readOnly.prEnv ?? {} : {}) };
  const env = Object.keys(envEntries).length ? { env: envEntries } : {};
  const configured = override.command?.trim();
  if (configured) {
    const found = find(configured);
    if (!found) return { ok: false, message: `The configured command for ${agent.label}, \`${configured}\`, was not found.` };
    const base = override.args && override.args.length > 0 ? override.args : [...agent.args];
    return { ok: true, command: found, args: [...base, ...extraArgs], ...env, source: "setting" };
  }
  for (const name of [agent.command, ...(agent.altCommands ?? [])]) {
    const found = find(name);
    if (found) return { ok: true, command: found, args: [...agent.args, ...extraArgs], ...env, source: "path" };
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
  const all = [...KNOWN_AGENTS, ...(custom ? [custom] : [])].map((agent) => ({ agent, launch: resolveAgentLaunch(agent, agent.id === CUSTOM_AGENT_ID ? {} : overrides(agent.id), "local", find) }));
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

/** The `_meta` sent with `session/new` for this agent and run. */
export function sessionMetaFor(agent: AgentDescriptor, source: { kind: RunKind }): Record<string, unknown> | undefined {
  return agent.readOnly.sessionMeta?.(source.kind);
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
