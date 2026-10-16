/**
 * The first-run screen's one next step (the approved design
 * "inbox-connect-next-step", variant C): what `GET /api/inbox/agents` says
 * about each agent on this computer, as the one most useful thing to do next
 * and the short lists of what is done and what is left. Plannotator's own
 * connections come first (Claude Code, Pi, OpenCode: replies wake the
 * session), agents reached through MCP after. Pure.
 */
import { INBOX_AGENT_IDS, inboxToolCostText, type InboxAgentId, type InboxAgentRow, type InboxAgentsModel } from '@plannotator/core/inbox-types';
import type { HarnessId } from './harnesses';

/** Plannotator's own connections, in the order the screen offers them. */
export const PLUGIN_HOSTS = ['claude-code', 'pi', 'opencode'] as const;
export type PluginHost = (typeof PLUGIN_HOSTS)[number];

export function isPluginHost(id: string): id is PluginHost {
  return (PLUGIN_HOSTS as readonly string[]).includes(id);
}

/** What the plugin is called on each host. */
export const PLUGIN_WORD: Readonly<Record<PluginHost, 'plugin' | 'extension'>> = { 'claude-code': 'plugin', pi: 'extension', opencode: 'plugin' };

/**
 * How one agent stands:
 *  - ready: Plannotator's plugin is installed and its Inbox tool is on.
 *  - tool-off: the plugin is installed, its Inbox tool is off (`locked` when PLANNOTATOR_INBOX_TOOL decides,
 *    `chosenOff` when config.json turns it off by name: both are left alone, never offered as a step).
 *  - mcp-only: a plugin host without the plugin, connected through MCP (replies don't wake it).
 *  - missing: a plugin host without the plugin, not connected.
 *  - mcp: another agent, connected through MCP.
 *  - connect: another agent the window can connect in one click (its `mcp add`, or one JSON key).
 *  - manual: another agent only a person can connect (`reason` says why).
 *  - absent: a plugin host not on this computer.
 */
export type ConnectState = 'ready' | 'tool-off' | 'mcp-only' | 'missing' | 'mcp' | 'connect' | 'manual' | 'absent';

export interface ConnectRow {
  id: InboxAgentId;
  label: string;
  state: ConnectState;
  locked: boolean;
  /** The person turned the tool off (config.json says false by name). */
  chosenOff: boolean;
  reason: string | null;
}

/**
 * One agent's state; null for an agent that is not here, or that the person
 * turned off or connected their own way. `live`: a session of this host is
 * polling the Inbox now, which only Plannotator's own connection does, so the
 * host is connected whatever the files the Inbox can read say (a project's own
 * `.claude/settings.json`, `claude --plugin-dir`).
 */
export function connectRowOf(row: InboxAgentRow, live = false): ConnectRow | null {
  const base = { id: row.id, label: row.label, locked: false, chosenOff: false, reason: row.reach.reason };
  if (isPluginHost(row.id)) {
    if (live) return { ...base, state: 'ready' };
    if (!row.detected) return { ...base, state: 'absent' };
    // The plugin is installed exactly when the agent reaches the Inbox through its tool (`plugin` says so too, on a newer Inbox).
    const installed = row.plugin ? row.plugin.installed : row.reach.kind === 'tool';
    if (installed && row.reach.kind === 'tool') {
      return row.reach.on ? { ...base, state: 'ready' } : { ...base, state: 'tool-off', locked: row.reach.locked, chosenOff: row.tool?.chosen_off === true };
    }
    if (row.reach.kind === 'mcp' && row.reach.on) return { ...base, state: 'mcp-only' };
    return { ...base, state: 'missing' };
  }
  if (!row.detected) return null;
  if (row.reach.on) return { ...base, state: 'mcp' };
  if (row.reach.kind === 'manual') return { ...base, state: 'manual' };
  // Not connected yet; one the person turned off, removed, or holds an entry of their own is theirs to decide.
  if (row.reach.kind === 'mcp' && row.reach.state === 'not_connected') return { ...base, state: 'connect' };
  return null;
}

/** Done: reaches the Inbox (through the plugin, or through MCP). */
export function isDone(row: ConnectRow): boolean {
  return row.state === 'ready' || row.state === 'mcp' || row.state === 'mcp-only';
}

/** A step the screen can offer: something left that the person can act on (a locked tool, or one the person turned off, is not one). */
export function isStep(row: ConnectRow): boolean {
  if (row.state === 'tool-off') return !row.locked && !row.chosenOff;
  return row.state === 'missing' || row.state === 'mcp-only' || row.state === 'connect' || row.state === 'manual';
}

/** Plannotator's own connections first (turn on, then install, then the plugin for an MCP-only host), MCP agents after. */
export function stepOrder(row: ConnectRow): number {
  const host = PLUGIN_HOSTS.indexOf(row.id as PluginHost);
  if (host >= 0) return host + 1 + ({ 'tool-off': 0, missing: 10, 'mcp-only': 20 } as Partial<Record<ConnectState, number>>)[row.state]!;
  return 40 + INBOX_AGENT_IDS.indexOf(row.id);
}

export interface ConnectPlan {
  /** Every agent the screen speaks about: Plannotator's hosts first, then the others in INBOX_AGENT_IDS order. */
  rows: ConnectRow[];
  /** The agents on this computer (absent plugin hosts left out). */
  found: ConnectRow[];
  /** What is left to do, in step order, without the ones put off with Not now. */
  steps: ConnectRow[];
  /** The one next step, or null (nothing left, or nothing found). */
  next: ConnectRow | null;
  done: ConnectRow[];
  /** Left, after the next step: the other steps, the ones put off, the tools locked or turned off. */
  later: ConnectRow[];
  /** Plugin hosts not on this computer. */
  absent: ConnectRow[];
}

export function connectPlan(model: InboxAgentsModel, skipped: readonly string[] = [], live: ReadonlySet<string> = new Set()): ConnectPlan {
  // Plannotator's own connections first, then the others, each in INBOX_AGENT_IDS order.
  const rank = (row: ConnectRow) => (isPluginHost(row.id) ? PLUGIN_HOSTS.indexOf(row.id) : PLUGIN_HOSTS.length + INBOX_AGENT_IDS.indexOf(row.id));
  const rows = model.agents
    .map((row) => connectRowOf(row, live.has(row.id)))
    .filter((row): row is ConnectRow => row !== null)
    .sort((a, b) => rank(a) - rank(b));
  const found = rows.filter((row) => row.state !== 'absent');
  const all = found.filter(isStep).sort((a, b) => stepOrder(a) - stepOrder(b));
  const steps = all.filter((row) => !skipped.includes(row.id));
  const next = steps[0] ?? null;
  const locked = found.filter((row) => row.state === 'tool-off' && (row.locked || row.chosenOff));
  const putOff = all.filter((row) => skipped.includes(row.id));
  return {
    rows,
    found,
    steps,
    next,
    done: found.filter(isDone),
    later: [...steps.slice(1), ...putOff, ...locked],
    absent: rows.filter((row) => row.state === 'absent'),
  };
}

/** The eyebrow over the next step: "Next step" (drawn in capitals) and where it stands. */
export function stepEyebrow(plan: ConnectPlan): { label: string; count: string } {
  return { label: 'Next step', count: plan.steps.length > 1 ? `1 of ${plan.steps.length}` : 'last one' };
}

/** The next step's title. */
export function stepTitle(row: ConnectRow): string {
  const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
  switch (row.state) {
    case 'tool-off':
      return `Turn on ${row.label}'s Inbox tool`;
    case 'mcp-only':
      return `Give ${row.label} Plannotator's ${word}`;
    case 'missing':
      return `Connect ${row.label} with Plannotator's ${word}`;
    case 'connect':
      return `Connect ${row.label}`;
    case 'manual':
      return `Connect ${row.label} by hand`;
    default:
      return row.label;
  }
}

/** The next step's sentence, in parts so the cost can be bold. */
export function stepText(row: ConnectRow): { text: string; cost?: string } {
  const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
  switch (row.state) {
    case 'tool-off':
      if (row.id === 'claude-code') return { text: 'Turn it on so Claude Code can send you messages and get your replies in the session.' };
      return {
        text: `Plannotator's ${word} is installed. Turn its Inbox tool on so ${row.label} can send you messages and get your replies in the session. It adds the tool to every ${row.label} request: `,
        cost: inboxToolCostText(row.id as 'pi' | 'opencode'),
      };
    case 'mcp-only':
      return { text: `Replies don't wake the session. Plannotator's ${word} does, and lets you message a running session.` };
    case 'missing':
      if (row.id === 'claude-code') return { text: "Plannotator's plugin connects it: your replies come back into the session by themselves." };
      if (row.id === 'opencode') return { text: "Plannotator's plugin connects it: on OpenCode 2 your replies come back into the session by themselves." };
      return { text: `Plannotator's ${word} connects it.` };
    case 'connect':
      return { text: `Adds the Inbox's MCP server to ${row.label}. Replies don't wake ${row.label}: it checks for them itself.` };
    case 'manual':
      return { text: row.reason ? `Only you can add it here: ${row.reason}.` : 'Only you can add it here.' };
    default:
      return { text: '' };
  }
}

/** What the "Already connected" line says after the name. */
export function doneNote(row: ConnectRow, opts: { live: boolean; turnedOn: boolean }): string {
  if (row.state === 'ready') {
    if (opts.turnedOn) return 'next session';
    const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
    return opts.live ? `${word} · running now` : word;
  }
  if (row.state === 'mcp-only') return 'MCP, no wake';
  return 'MCP';
}

/** What the "Left to do" line says after the name. */
export function laterNote(row: ConnectRow, opts: { skipped: boolean; toolEnv: boolean | null }): string {
  if (row.state === 'tool-off' && row.locked) return `locked by PLANNOTATOR_INBOX_TOOL=${opts.toolEnv ? '1' : '0'}`;
  if (row.state === 'tool-off' && row.chosenOff) return 'off';
  if (opts.skipped) return 'later';
  if (row.state === 'tool-off') return 'turn on';
  if (row.state === 'connect') return 'connect';
  if (row.state === 'manual') return 'by hand';
  return 'install';
}

/** The picker tab whose command connects an agent by hand. */
export function harnessOf(id: InboxAgentId): HarnessId {
  return id as HarnessId;
}

/** The commands that install Plannotator's own connection. */
export const CLAUDE_PLUGIN_INSTALL = 'claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator';
export const PI_EXTENSION_INSTALL = 'pi install npm:@plannotator/pi-extension';
export const OPENCODE_PLUGIN_LINES = {
  '2': '"plugins": [{ "package": "@plannotator/opencode@latest" }]',
  '1': '"plugin": ["@plannotator/opencode@latest"]',
} as const;
export const OPENCODE_CONFIG_PATH = '~/.config/opencode/opencode.json';

/** "In a new Claude Code or Codex session, ask:" — the first two agents that reach the Inbox. */
export function tryWho(names: readonly string[]): string {
  return names.length ? `In a new ${names.slice(0, 2).join(' or ')} session, ask:` : 'Once an agent is connected, ask it in a new session:';
}

/** The sentence an agent is given to try the Inbox. */
export const TRY_PROMPT = 'Send me a test message in my Plannotator Inbox.';
