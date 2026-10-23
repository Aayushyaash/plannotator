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

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
   * Why a pull request is not offered to this agent: Guides cannot keep the
   * PR's own project config (which can start programs or allow commands) from
   * loading. Local changes only. Fails closed: every agent that Guides cannot
   * isolate from a PR's config sets this.
   */
  refusePullRequests?: string;
  /**
   * A check of the PR's checked-out head before a pull request run starts:
   * a reason to refuse it, or null. Fails closed (an unreadable file refuses).
   */
  prPreflight?(headRoot: string): string | null;
  /** Why this agent cannot write a guide at all yet: shown, never started. */
  unsupported?: string;
  /** Sign in in a terminal when the agent lists no terminal sign-in of its own. */
  signIn?: { command: string; args: readonly string[] };
}

/**
 * Claude Code's tools that change files or run commands, refused by the
 * adapter itself on every run (`disallowedTools`). Claude Code calls
 * `canUseTool` (and so the client's permission request) only when its own
 * rules say "ask": the user's allow rules (`Bash(npm test:*)` in
 * ~/.claude/settings.json), sandbox auto-allow and its built-in read-only
 * auto-approvals run commands without a request, so Bash is refused at the
 * agent, not only by the permission policy.
 */
export const CLAUDE_DISALLOWED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "KillBash"];
/** Also refused on a pull request run: the network (a PR's text must not send what the agent read anywhere). */
export const CLAUDE_PR_DISALLOWED_TOOLS = ["WebFetch", "WebSearch"];

/**
 * Project settings keys that make Claude Code start a program. claude-agent-acp
 * runs `claude auth status --json` with the session's folder as cwd and without
 * `--setting-sources`, so the CLI may read the PR's own `.claude/settings*.json`
 * there; whether it runs these then cannot be checked (the CLI is closed), so a
 * PR that sets any of them is refused.
 */
export const CLAUDE_COMMAND_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "env"];

/** The reason to refuse a PR whose `.claude/settings*.json` would start a program, or null. */
export function claudePrSettingsRisk(headRoot: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  for (const name of ["settings.json", "settings.local.json"]) {
    const rel = `.claude/${name}`;
    let text: string;
    try {
      text = read(join(headRoot, ".claude", name));
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT" || (err as { code?: string }).code === "ENOTDIR") continue;
      return `Its ${rel} could not be read, so Guides cannot tell whether Claude Code's sign-in check would run a program from it.`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return `Its ${rel} is not plain JSON, so Guides cannot tell whether Claude Code's sign-in check would run a program from it.`;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const hit = CLAUDE_COMMAND_SETTINGS.filter((k) => Object.hasOwn(parsed as object, k));
    if (hit.length) return `Its ${rel} sets ${hit.join(", ")}, which Claude Code's sign-in check (\`claude auth status\`, run in the PR's folder) could act on.`;
  }
  return null;
}

/**
 * Claude Code through its ACP adapter. Source: the adapter's README and
 * `src/acp-agent.ts`, https://github.com/agentclientprotocol/claude-agent-acp.
 * Every run sends `_meta.claudeCode.options` (the adapter spreads it over its
 * own options and merges `disallowedTools` with its own list): the tools that
 * write or run commands are disallowed, and `strictMcpConfig` keeps every MCP
 * server out but ours (the user's MCP tools could be allowed without asking).
 * A pull request also loads the user's settings only (no hooks, allow rules or
 * MCP servers from the PR), refuses bypass, disallows the network, and is
 * refused when its own `.claude/settings*.json` sets a command (see
 * `claudePrSettingsRisk`). The adapter still starts the session in the cwd's
 * `permissions.defaultMode`, so every run is set back to `default`.
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
    summary: "Runs in Claude Code's default permission mode with its edit, write and shell tools disallowed and no MCP server but Guides'; a pull request also loads only your user settings and has no network.",
    sessionMeta: (run) => ({
      claudeCode: {
        options:
          run === "pr"
            ? { settingSources: ["user"], strictMcpConfig: true, allowDangerouslySkipPermissions: false, disallowedTools: [...CLAUDE_DISALLOWED_TOOLS, ...CLAUDE_PR_DISALLOWED_TOOLS] }
            : { strictMcpConfig: true, disallowedTools: [...CLAUDE_DISALLOWED_TOOLS] },
      },
    }),
    mode: { ids: ["default"], label: "the default permission mode" },
  },
  prPreflight: (headRoot) => claudePrSettingsRisk(headRoot),
  signIn: { command: "claude", args: ["/login"] },
};

/**
 * Codex through `codex-acp`. Source: https://github.com/agentclientprotocol/codex-acp
 * (README; `src/AgentMode.ts`: the `read-only` mode is a read-only sandbox
 * that asks before edits and network; `INITIAL_AGENT_MODE` sets the starting
 * mode). Its default mode, `agent`, writes in the workspace without asking.
 * Commands it judges read-only still run in its read-only sandbox without a
 * request. Pull requests are refused: codex-acp marks every session folder
 * trusted (`CodexAcpClient.ts`), so a PR's own `.codex/` config (MCP servers,
 * hooks, rules) would load.
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

/** The OpenCode agent Guides defines and runs in (`agent.<name>` in the injected config). */
export const OPENCODE_GUIDE_AGENT = "plannotator-guide-review";

/**
 * The config Guides gives OpenCode through `OPENCODE_CONFIG_CONTENT`: its own
 * primary agent, whose permission rules no other config defines, so they are
 * merged last (OpenCode v1.19.4 `agent/agent.ts`: an agent's rules are
 * `defaults`, then the top-level `permission`, then `agent.<name>.permission`;
 * last match wins). `"*"` comes first so every rule after it is an exception.
 * Keys from v1.19.4's permission schema (`core/src/v1/config/permission.ts`)
 * and tools; MCP tools are checked as `<server>_<tool>`. `lsp: false` keeps
 * language servers (which can resolve from the PR's own node_modules) off.
 */
export function openCodeConfig(run: RunKind): string {
  const permission = {
    "*": "ask",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
    grep: "allow",
    glob: "allow",
    list: "allow",
    todowrite: "allow",
    "plannotator-guide_*": "allow",
    external_directory: "ask",
    edit: "deny",
    bash: "deny",
    task: "deny",
    lsp: "deny",
    question: "deny",
    webfetch: run === "pr" ? "deny" : "ask",
    websearch: "deny",
    codesearch: "deny",
  };
  return JSON.stringify({
    lsp: false,
    agent: {
      [OPENCODE_GUIDE_AGENT]: {
        mode: "primary",
        description: "Plannotator guided review: reads only.",
        permission,
      },
    },
  });
}

/**
 * OpenCode's `opencode acp`. Sources: https://opencode.ai/docs/acp/ and the
 * v1.19.4 source (anomalyco/opencode `packages/opencode/src/agent/agent.ts`,
 * `config/config.ts`, `config/paths.ts`, `lsp/lsp.ts`, `mcp/catalog.ts`).
 * OpenCode's default permission is `"*": "allow"`: edits, shell, the user's
 * MCP and plugin tools run without asking. Guides runs in its own agent
 * (`openCodeConfig`), which asks about everything but reads, searches and the
 * guide's tools, and denies edits, shell and subagents. A pull request also
 * gets `OPENCODE_DISABLE_PROJECT_CONFIG` (no `opencode.json`, no `.opencode/`
 * plugins, agents or MCP servers from the PR), `OPENCODE_DISABLE_CLAUDE_CODE`,
 * and no network.
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
    summary: "Runs in Guides' own OpenCode agent, which denies edits, shell and subagents and asks about any tool but reads, searches and the guide's tools; a pull request also skips the PR's own OpenCode config and has no network.",
    env: { OPENCODE_CONFIG_CONTENT: openCodeConfig("local") },
    prEnv: { OPENCODE_CONFIG_CONTENT: openCodeConfig("pr"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    mode: { ids: [OPENCODE_GUIDE_AGENT], label: `Guides' read-only OpenCode agent (${OPENCODE_GUIDE_AGENT})` },
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
  refusePullRequests: "Guides cannot keep a pull request's own Copilot configuration from loading. Guides runs Copilot CLI on local changes only.",
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
  refusePullRequests: "Cursor reads a pull request's own .cursor/cli.json (allow rules), .cursor/hooks.json and .cursor/mcp.json, and Guides cannot turn that off. Guides runs Cursor on local changes only.",
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
  refusePullRequests: "Kiro reads a pull request's own .kiro/ settings (MCP servers, agents and their hooks), and whether its workspace-trust gate applies to ACP sessions is not documented. Guides runs Kiro CLI on local changes only.",
};

/**
 * Kilo Code's CLI (an OpenCode fork). Sources: https://kilo.ai/docs and the
 * source (`packages/opencode/src/cli/cmd/acp.ts`, `kilocode/agent/index.ts`,
 * `config/paths.ts`, `core/src/flag/flag.ts` in Kilo-Org/kilocode); the npm
 * package `@kilocode/cli` installs `kilo` and `kilocode`. Its `ask` mode
 * denies edits, writes and shell commands other than read-only ones, and
 * config cannot widen it except per agent; it allows web fetch and search,
 * which Guides denies with `KILO_CONFIG_CONTENT` (the user's denies land last
 * in `kilocode/agent/index.ts`). Its default `code` mode edits without asking.
 * Pull requests are refused: `KILO_DISABLE_PROJECT_CONFIG` does not stop a
 * PR's `.kilocode/mcp.json` or `.kilo/mcp.json` (migrated by `config.ts`
 * `loadLegacyConfigs` without the flag), whose stdio servers start with it.
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
    summary: "Runs in Kilo's ask mode, which denies edits and shell commands other than read-only ones, with web fetch and search denied.",
    env: { KILO_CONFIG_CONTENT: JSON.stringify({ permission: { webfetch: "deny", websearch: "deny" } }) },
    mode: { ids: ["ask"], label: "its ask mode" },
  },
  refusePullRequests: "Kilo starts the MCP servers in a pull request's own .kilocode/mcp.json or .kilo/mcp.json even with project config turned off. Guides runs Kilo Code on local changes only.",
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
    refusePullRequests: "Guides cannot keep a pull request's own configuration from loading for a custom agent. The custom agent runs on local changes only.",
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
