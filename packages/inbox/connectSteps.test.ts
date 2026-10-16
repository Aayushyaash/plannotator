/**
 * The first-run screen's one next step (connectSteps.ts), on the approved
 * mock's computers: which agent comes next, what is done, what is left.
 * Plannotator's own connections always come before an agent reached through
 * MCP, and a locked tool is never offered as a step.
 */
import { expect, test } from 'bun:test';
import { INBOX_TOOL_COST, inboxToolCostText } from '@plannotator/core/inbox-types';
import { connectPlan, connectRowOf, doneNote, laterNote, stepEyebrow, stepText, stepTitle } from './connectSteps';
import { SCENARIOS, agentsModel, missing, toolOff, viaMcp } from './connectSteps.fixtures';

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

test('typical: Pi turns on first (1 of 2), OpenCode is left to install, Claude Code, Codex and Cursor are done', () => {
  const plan = connectPlan(SCENARIOS.typical());
  expect(plan.next?.id).toBe('pi');
  expect(stepEyebrow(plan)).toEqual({ label: 'Next step', count: '1 of 2' });
  expect(stepTitle(plan.next!)).toBe("Turn on Pi's Inbox tool");
  expect(stepText(plan.next!).cost).toBe(inboxToolCostText('pi'));
  expect(ids(plan.done)).toEqual(['claude-code', 'codex', 'cursor']);
  expect(ids(plan.later)).toEqual(['opencode']);
  expect(laterNote(plan.later[0]!, { skipped: false, toolEnv: null })).toBe('install');
  expect(doneNote(plan.done[0]!, { live: true, turnedOn: false })).toBe('plugin · running now');
  expect(doneNote(plan.done[1]!, { live: false, turnedOn: false })).toBe('MCP');
});

test('Not now puts a step off: the next one comes up, the put-off one stays in Left to do as later', () => {
  const plan = connectPlan(SCENARIOS.typical(), ['pi']);
  expect(plan.next?.id).toBe('opencode');
  expect(stepEyebrow(plan).count).toBe('last one');
  expect(stepTitle(plan.next!)).toBe("Connect OpenCode with Plannotator's plugin");
  expect(ids(plan.later)).toEqual(['pi']);
  expect(laterNote(plan.later[0]!, { skipped: true, toolEnv: null })).toBe('later');
});

test('plugin missing: Claude Code installs before Pi gets its extension; Pi through MCP counts as done, without the wake; OpenCode is not here', () => {
  const plan = connectPlan(SCENARIOS.missing());
  expect(plan.next?.id).toBe('claude-code');
  expect(stepTitle(plan.next!)).toBe("Connect Claude Code with Plannotator's plugin");
  expect(ids(plan.done)).toEqual(['pi', 'codex']);
  expect(doneNote(plan.done.find((row) => row.id === 'pi')!, { live: false, turnedOn: false })).toBe('MCP, no wake');
  expect(ids(plan.later)).toEqual(['pi']);
  expect(stepTitle(plan.later[0]!)).toBe("Give Pi Plannotator's extension");
  expect(ids(plan.absent)).toEqual(['opencode']);
});

test('nothing found: no step and nothing done, the three hosts absent', () => {
  const plan = connectPlan(SCENARIOS.none());
  expect(plan.found).toEqual([]);
  expect(plan.next).toBeNull();
  expect(ids(plan.absent)).toEqual(['claude-code', 'pi', 'opencode']);
});

test('locked: a tool PLANNOTATOR_INBOX_TOOL keeps off is never a step, and says why in Left to do', () => {
  const plan = connectPlan(SCENARIOS.locked());
  expect(plan.next?.id).toBe('opencode');
  expect(stepEyebrow(plan).count).toBe('last one');
  expect(ids(plan.later)).toEqual(['claude-code', 'pi']);
  expect(laterNote(plan.later[0]!, { skipped: false, toolEnv: false })).toBe('locked by PLANNOTATOR_INBOX_TOOL=0');
});

test('MCP agents come after every Plannotator host; one the person turned off or removed is not nagged about', () => {
  const model = agentsModel({
    codex: { detected: true, reach: { kind: 'mcp', on: false, state: 'not_connected', path: null, locked: false, reason: null } },
    gemini: { detected: true, reach: { kind: 'mcp', on: false, state: 'off', path: null, locked: false, reason: null } },
    cursor: { detected: true, reach: { kind: 'mcp', on: false, state: 'removed', path: null, locked: false, reason: null } },
    cline: { detected: true, reach: { kind: 'manual', on: false, state: 'manual', path: null, locked: false, reason: "Cline's MCP command is not verified" } },
    opencode: missing('opencode'),
    pi: toolOff(),
  });
  const plan = connectPlan(model);
  expect(ids(plan.steps)).toEqual(['pi', 'opencode', 'codex', 'cline']);
  expect(stepTitle(plan.steps[2]!)).toBe('Connect Codex');
  expect(stepTitle(plan.steps[3]!)).toBe('Connect Cline by hand');
  expect(stepText(plan.steps[3]!).text).toBe("Only you can add it here: Cline's MCP command is not verified.");
});

test('an older Inbox without the plugin field: the tool means the plugin is installed', () => {
  const row = { ...agentsModel({ pi: viaMcp('pi') }).agents.find((agent) => agent.id === 'pi')! };
  delete row.plugin;
  expect(connectRowOf(row)?.state).toBe('mcp-only');
  const tool = { ...agentsModel({ pi: toolOff() }).agents.find((agent) => agent.id === 'pi')! };
  delete tool.plugin;
  expect(connectRowOf(tool)?.state).toBe('tool-off');
});

test('the cost the screen states is the measured one', () => {
  // The size is measured; tokens depend on the model, so the window says "roughly".
  expect(inboxToolCostText('pi')).toBe(`about ${Math.round(INBOX_TOOL_COST.pi.bytes / 1000)} KB, roughly ${INBOX_TOOL_COST.pi.tokens.toLocaleString('en-US')} tokens`);
  expect(INBOX_TOOL_COST.pi.tokens).toBeGreaterThan(0);
});

test('a live session of a Plannotator host counts as connected; a tool turned off by name is left to the person', () => {
  const plan = connectPlan(SCENARIOS.missing(), [], new Set(['claude-code']));
  expect(plan.next?.id).toBe('pi');
  expect(ids(plan.done)).toEqual(['claude-code', 'pi', 'codex']);
  const model = agentsModel({ pi: { ...toolOff(), tool: { on: false, locked: false, chosen_off: true } } });
  const off = connectPlan(model);
  expect(off.next).toBeNull();
  expect(ids(off.later)).toEqual(['pi']);
  expect(laterNote(off.later[0]!, { skipped: false, toolEnv: null })).toBe('off');
});
