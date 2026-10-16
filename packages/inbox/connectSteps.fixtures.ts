/**
 * The approved mock's computers (inbox-connect-next-step: Typical, Plugin
 * missing, Nothing found, Tool locked off) as `GET /api/inbox/agents` answers
 * them, for the first-run screen's tests.
 */
import { INBOX_AGENT_IDS, INBOX_AGENT_LABELS, type InboxAgentId, type InboxAgentRow, type InboxAgentsModel } from '@plannotator/core/inbox-types';

type Reach = InboxAgentRow['reach'];
const reach = (over: Partial<Reach>): Reach => ({ kind: 'mcp', on: false, state: 'not_connected', path: null, locked: false, reason: null, ...over });
const host = (id: InboxAgentId) => id === 'claude-code' || id === 'pi' || id === 'opencode';

function agent(id: InboxAgentId, over: Partial<InboxAgentRow> = {}): InboxAgentRow {
  return {
    id,
    label: INBOX_AGENT_LABELS[id],
    detected: false,
    reach: host(id) ? reach({ kind: id === 'opencode' ? 'manual' : 'mcp', state: id === 'opencode' ? 'manual' : 'not_connected' }) : reach({}),
    tool: host(id) ? { on: false, locked: false } : null,
    reminder: host(id) ? { on: false, locked: false, needs_tool: true } : null,
    note: null,
    plugin: host(id) ? { installed: false } : null,
    ...over,
  };
}

/** Plannotator's plugin installed: the tool on, or off (locked by PLANNOTATOR_INBOX_TOOL). */
export const ready = (): Partial<InboxAgentRow> => ({ detected: true, reach: reach({ kind: 'tool', on: true, state: 'connected' }), plugin: { installed: true } });
export const toolOff = (locked = false): Partial<InboxAgentRow> => ({
  detected: true,
  reach: reach({ kind: 'tool', on: false, state: 'off', locked }),
  tool: { on: false, locked },
  plugin: { installed: true },
});
/** A plugin host found without its plugin, not connected. */
export const missing = (id: InboxAgentId): Partial<InboxAgentRow> => ({
  detected: true,
  reach: reach(id === 'pi' ? { kind: 'mcp', state: 'not_connected' } : { kind: 'manual', state: 'manual', reason: id === 'claude-code' ? "install Plannotator's Claude Code plugin" : "add Plannotator's OpenCode plugin, or the server to opencode.json" }),
  plugin: { installed: false },
});
/** Connected through MCP (a plugin host without its plugin: MCP only). */
export const viaMcp = (id: InboxAgentId): Partial<InboxAgentRow> => ({ detected: true, reach: reach({ kind: 'mcp', on: true, state: 'connected', path: `~/.${id}/config` }) });

export function agentsModel(rows: Partial<Record<InboxAgentId, Partial<InboxAgentRow>>>, over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: INBOX_AGENT_IDS.map((id) => agent(id, rows[id] ?? {})),
    last_report: null,
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: true,
    note_text: '',
    ...over,
  };
}

export const SCENARIOS = {
  /** Claude Code with the plugin (a session running), Pi with the extension and the tool off, OpenCode without its plugin, Codex and Cursor through MCP. */
  typical: () => agentsModel({ 'claude-code': ready(), pi: toolOff(), opencode: missing('opencode'), codex: viaMcp('codex'), cursor: viaMcp('cursor') }),
  /** Claude Code on PATH without the plugin, Pi without the extension but through MCP, Codex through MCP. */
  missing: () => agentsModel({ 'claude-code': missing('claude-code'), pi: viaMcp('pi'), codex: viaMcp('codex') }),
  /** No agent on this computer. */
  none: () => agentsModel({}),
  /** The typical computer with PLANNOTATOR_INBOX_TOOL=0. */
  locked: () =>
    agentsModel(
      { 'claude-code': toolOff(true), pi: toolOff(true), opencode: missing('opencode'), codex: viaMcp('codex'), cursor: viaMcp('cursor') },
      { tool_env: false },
    ),
} as const;
