/**
 * Compose's rules alone (compose/model.ts). What can regress: To preselecting
 * the wrong session (or one that is not live), the current project not
 * leading the picker, the palette offering an action no words asked for,
 * closing an empty compose asking a question (or a changed one not asking).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxComposeProject } from '@plannotator/core/inbox-types';
import { derivePersonThreadSubject } from '@plannotator/core/inbox-questions';
import {
  actionLabel,
  composeActions,
  composeGroups,
  composeTargets,
  composeThreadName,
  draftChip,
  draftThreadName,
  sendThreadName,
  shownThreadName,
  suggestThreadName,
  threadNameStateOf,
  typeThreadName,
  filterGroups,
  isDirty,
  namesActionWord,
  pickerRows,
  preselect,
  statusLine,
  subjectPreview,
} from './compose/model';

const session = (id: string, host: string, extra: Partial<InboxComposeProject['sessions'][number]> = {}) => ({
  session: id,
  host,
  started_at: '2026-10-14T09:12:00.000Z',
  last_seen_at: '2026-10-14T15:00:00.000Z',
  busy: false,
  idle_since: '2026-10-14T14:00:00.000Z',
  last_thread: null,
  ...extra,
});

const PROJECTS: InboxComposeProject[] = [
  { project: { id: 'prj_w', name: 'workspaces', root: '/src/workspaces' }, sessions: [session('ses-oc', 'opencode', { busy: true })] },
  { project: { id: 'prj_p', name: 'plannotator', root: '/src/plannotator' }, sessions: [session('ses-cc1', 'claude-code'), session('ses-pi', 'pi')] },
  { project: { id: null, name: 'billing', root: '/src/billing' }, sessions: [session('ses-pi2', 'pi')] },
];

describe('To', () => {
  test('preselects the last session sent to while it is live, else the current project\'s most active, else the most active anywhere; nothing when none is live', () => {
    const current = { id: 'prj_p', root: '/src/plannotator' };
    expect(preselect(PROJECTS, { last: 'ses-pi2', current })?.session).toBe('ses-pi2');
    expect(preselect(PROJECTS, { last: 'ses-gone', current })?.session).toBe('ses-cc1');
    expect(preselect(PROJECTS, { last: null, current: null })?.session).toBe('ses-oc');
    expect(preselect([], { last: 'ses-pi', current })).toBeNull();
  });

  test('the picker puts the current project first, marked; the filter matches host, project and last subject', () => {
    const groups = composeGroups(PROJECTS, { id: null, root: '/src/billing' });
    expect(groups.map((g) => [g.project.name, g.current])).toEqual([
      ['billing', true],
      ['workspaces', false],
      ['plannotator', false],
    ]);
    expect(filterGroups(groups, 'pi plan').flatMap((g) => g.sessions.map((s) => s.session))).toEqual(['ses-pi']);
    const withSubject = composeGroups([{ ...PROJECTS[1]!, sessions: [session('ses-x', 'claude-code', { last_thread: { id: 'msg_1', subject: 'Relay rate limit', at: '2026-10-14T14:50:00.000Z' } })] }], null);
    expect(filterGroups(withSubject, 'rate').length).toBe(1);
    expect(filterGroups(groups, 'nothing-like-this')).toEqual([]);
  });

  test('the picker is one row per session, the current project first; a start time only where a project has two live sessions, whatever the filter', () => {
    const groups = composeGroups(PROJECTS, { id: null, root: '/src/billing' });
    const rows = pickerRows(groups);
    expect(rows.map((r) => r.target.session)).toEqual(['ses-pi2', 'ses-oc', 'ses-cc1', 'ses-pi']);
    expect(rows.map((r) => r.started !== null)).toEqual([false, false, true, true]);
    // Filtered down to one plannotator session, it still names its start: the other one is live.
    const filtered = pickerRows(filterGroups(groups, 'pi plan'), groups);
    expect(filtered.map((r) => [r.target.session, r.started !== null])).toEqual([['ses-pi', true]]);
  });

  test('the status line says who takes it, or why nothing can be sent', () => {
    const [oc] = composeTargets(PROJECTS);
    expect(statusLine({ target: oc!, anyLive: true, ended: null, projectName: null })).toBe('OpenCode is working; it takes this when its turn ends.');
    expect(statusLine({ target: composeTargets(PROJECTS)[1]!, anyLive: true, ended: null, projectName: null })).toBe('Claude Code takes it as its next turn.');
    expect(statusLine({ target: null, anyLive: true, ended: null, projectName: 'ledger' })).toBe('Choose an agent to send it.');
    expect(statusLine({ target: null, anyLive: false, ended: null, projectName: 'ledger', loading: true })).toBe('Looking for live agents…');
    expect(statusLine({ target: null, anyLive: false, ended: null, projectName: 'ledger' })).toBe('No agent is running in ledger.');
    expect(statusLine({ target: null, anyLive: true, ended: { host: 'pi', session: 's', project_root: null, project_name: null, started_at: null }, projectName: null })).toBe('That session has ended.');
  });
});

describe('closing', () => {
  test('an empty new message closes without asking; words or files ask; a saved draft asks only when something changed', () => {
    const empty = { body: '', session: null, files: [] };
    expect(isDirty({ body: '  ', session: 'ses-pi', files: [] }, empty, false)).toBe(false);
    expect(isDirty({ body: 'An idea', session: null, files: [] }, empty, false)).toBe(true);
    expect(isDirty({ body: '', session: null, files: ['upl_1'] }, empty, false)).toBe(true);
    const saved = { body: 'An idea', session: 'ses-pi', files: ['upl_1'] };
    expect(isDirty({ ...saved }, saved, true)).toBe(false);
    expect(isDirty({ ...saved, session: 'ses-cc1' }, saved, true)).toBe(true);
    expect(isDirty({ ...saved, files: [] }, saved, true)).toBe(true);
  });

  test('a draft\'s chip is worded, never colour alone', () => {
    const to = { host: 'claude-code', session: 's', project_root: null, project_name: null, started_at: null };
    expect(draftChip({ to, status: 'live' })).toBe('Claude Code is live');
    expect(draftChip({ to, status: 'ended' })).toBe('That session ended');
    expect(draftChip({ to: null, status: 'none' })).toBe('No agent chosen');
  });
});

describe('the palette\'s Actions', () => {
  const targets = composeTargets(PROJECTS);
  test('an empty query: New message… and the session last sent to while it is live', () => {
    expect(composeActions('', targets, 'ses-pi').map(actionLabel)).toEqual(['New message…', 'Message Pi in plannotator']);
    expect(composeActions('', targets, 'ses-gone').map(actionLabel)).toEqual(['New message…']);
  });

  test('typed words: the action words offer New message…; a host or project names the sessions; other words offer nothing', () => {
    expect(composeActions('new', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(composeActions('idea', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(composeActions('pi', targets, null).map(actionLabel)).toEqual(['Message Pi in plannotator', 'Message Pi in billing']);
    expect(composeActions('message billing', targets, null).map(actionLabel)).toEqual(['New message…', 'Message Pi in billing']);
    expect(composeActions('relay timeout', targets, null)).toEqual([]);
  });

  test('a word calls an action whole or by 3 letters of its start; two letters, or words off the brief\'s list, do not', () => {
    const offersNew = (q: string) => composeActions(q, targets, null).some((a) => a.kind === 'new');
    for (const word of ['re', 'co', 'me', 'as', 'compose', 'draft', 'write']) expect(offersNew(word)).toBe(false);
    expect(composeActions('mes', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(composeActions('sen', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(namesActionWord('send it')).toBe(true);
    expect(namesActionWord('mes')).toBe(false);
    expect(namesActionWord('newsletter')).toBe(false);
  });
});

describe('the subject preview and the thread name', () => {
  test("the preview is the store's rule for a thread the person starts, so what compose shows is what is stored", () => {
    const dictated = 'I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out.';
    expect(subjectPreview(dictated)).toBe(derivePersonThreadSubject(dictated));
    expect(subjectPreview(dictated)).toBe('I want to explore what adding a board would look like');
    expect(subjectPreview('   ')).toBeNull();
  });

  test('a thread name: empty is none, a valid one is trimmed, an invalid one says why', () => {
    expect(composeThreadName('  ')).toEqual({ name: '' });
    expect(composeThreadName('  Kanban board ')).toEqual({ name: 'Kanban board' });
    expect(composeThreadName('a\nb')).toEqual({ error: 'Thread name must not contain control characters or line breaks.' });
    expect('error' in composeThreadName('x'.repeat(121))).toBe(true);
  });

  test('a changed thread name alone makes a saved draft dirty; a name alone makes a new message dirty', () => {
    const saved = { body: 'hi', session: null, files: [], threadName: 'Board' };
    expect(isDirty({ ...saved }, saved, true)).toBe(false);
    expect(isDirty({ ...saved, threadName: 'Kanban' }, saved, true)).toBe(true);
    expect(isDirty({ body: '', session: null, files: [], threadName: 'Board' }, { body: '', session: null, files: [] }, false)).toBe(true);
  });

  test('the chip follows the message until typed in; emptied, it follows again', () => {
    const fresh = threadNameStateOf(null);
    expect(fresh).toEqual({ typed: '', edited: false });
    expect(shownThreadName(fresh, 'Paste bug')).toBe('Paste bug');
    const typed = typeThreadName('Board ideas');
    expect(typed).toEqual({ typed: 'Board ideas', edited: true });
    // The suggestion moves on; the typed name does not.
    expect(shownThreadName(typed, 'Kanban board')).toBe('Board ideas');
    expect(typeThreadName('   ')).toEqual({ typed: '', edited: false });
    expect(typeThreadName('')).toEqual({ typed: '', edited: false });
  });

  test('a draft keeps the typed name only, and opens in the state it was saved in', () => {
    expect(draftThreadName(typeThreadName('Kanban board'))).toBe('Kanban board');
    expect(draftThreadName(threadNameStateOf(null))).toBe('');
    expect(threadNameStateOf({ thread_name: 'Kanban board' })).toEqual({ typed: 'Kanban board', edited: true });
    expect(threadNameStateOf({ thread_name: '  ' })).toEqual({ typed: '', edited: false });
    expect(threadNameStateOf({})).toEqual({ typed: '', edited: false });
  });

  test('a Send carries the typed name as is, the suggestion marked auto, or nothing', () => {
    expect(sendThreadName(typeThreadName('  Kanban board '), 'Paste bug')).toEqual({ thread_name: 'Kanban board' });
    expect(sendThreadName(threadNameStateOf(null), 'Paste bug')).toEqual({ thread_name: 'Paste bug', thread_name_auto: true });
    expect(sendThreadName(threadNameStateOf(null), '')).toEqual({});
    expect(sendThreadName(typeThreadName('a\u202eb'), 'Paste bug')).toEqual({ error: 'Thread name must not contain bidirectional control characters.' });
  });

  test("the suggestion is the core namer's, short, from the words or else the files", () => {
    expect(suggestThreadName('can you fix the paste bug in the reply box')).toBe('Paste bug');
    expect(suggestThreadName('', ['relay-retry-budget.md'])).toBe('Relay retry budget');
    expect(suggestThreadName('What do you think?')).toBe('');
  });
});
