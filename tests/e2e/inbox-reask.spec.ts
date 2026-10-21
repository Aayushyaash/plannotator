/**
 * Re-ask (approval "inbox-reask"), proved in a real browser against the
 * compiled binary. Nothing is mocked: the binary runs `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, Claude Code
 * agents ask through `plannotator inbox mcp` (scripts/inbox-sim.ts), and the
 * agent connections are the bridge's real doors driven as a connection
 * drives them (the harness of inbox-ended-session.spec.ts).
 *
 * One session asks three questions over two messages; the person presses
 * Re-ask; the note waits Queued (the session is working) with Send now, the
 * row is in Sent, the connection is handed the note with the Re-ask wake
 * line; delivered; the agent re-asks two with `Replaces:` lines and drops
 * one with `supersedes`, and the old cards read Replaced and No longer
 * applies. Then: a session that ended (the choice, "Who should ask again?"),
 * and the foot on a phone in WebKit.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop 1440 and 1280, light and dark, and a phone) land in
 * .local/proof/reask/ (or PLANNOTATOR_E2E_PROOF_DIR/reask).
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_REASK_INSTRUCTION,
  inboxReaskRedirectedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reask');

const q = (prompt: string, context: string, choices: string[], recommended: string) =>
  [':::question', prompt, '', context, '', ...choices.map((c) => `- [ ] ${c}`), '', `Recommended: ${recommended}`, ':::'].join('\n');

const FIRST = [
  'I mapped every write path into the old `invoices` table. Two decisions block the cut-over script.',
  '',
  q('Which table should the backfill write to first?', '`ledger_entries` is empty; `invoices_v2` already has 3 days of dual-writes.', ['ledger_entries first', 'invoices_v2 first'], 'ledger_entries first'),
  '',
  q('Do we keep the old webhook payload for a release?', 'Two customers parse `amount_cents` as a string.', ['Keep it for one release', 'Drop it now'], 'Keep it for one release'),
].join('\n');
const SECOND = ['While you were away I found a third thing: refunds still go through the legacy queue.', '', q('Should refunds move in this migration?', 'Moving them now adds about a day.', ['This migration', 'The next one'], 'The next one')].join('\n');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  second: string;
  asker: string;
  connections: Connection[];
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One agent session's connection: long-polls for what the person sent it, and acknowledges a delivery. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly busy: boolean,
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: 'claude-code', ...body }),
    });
  }

  private async run(): Promise<void> {
    const started = Date.now() - 30 * 60_000;
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: world.billing,
        started_at: started,
        busy: this.busy,
        idle_since: this.busy ? null : started,
        send_now: true,
      }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        if (!this.commands.some((known) => known.id === command.id)) this.commands.push(command);
      }
    }
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Message = { id: string; author: { kind: string; session?: string }; reask?: string[]; to?: { session: string } | null; questions?: { state: string; message_id: string; key: string }[] };
async function threadMessages(threadId: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { messages: Message[] } }).thread.messages;
}
async function sectionOf(threadId: string): Promise<string | undefined> {
  const list = (await (await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads`)).json()) as { sections: { id: string; threads: { thread_id: string }[] }[] };
  return list.sections.find((s) => s.threads.some((t) => t.thread_id === threadId))?.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-reask-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const billing = scratchProject(join(root, 'src'), 'billing');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const first = await claude.send({ project_path: billing, subject: 'Billing migration: two calls before I cut over', body: FIRST }, { wakes: true });
  const second = await claude.send({ project_path: billing, reply_to: first.message_id as string, body: SECOND }, { wakes: true });
  world = { root, dataDir, env, url, billing, claude, context, page, errors, threadId: first.thread_id as string, second: second.message_id as string, asker: '', connections: [] };
  world.asker = (await threadMessages(world.threadId))[0]!.author.session!;
  // The one-time notification line is not what these shots are about.
  await fetch(`http://127.0.0.1:${registry().port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('Re-ask: the note waits Queued with Send now, the row is Sent, the agent gets the Re-ask wake, and its new message replaces the old cards', async () => {
  const { page } = world;
  const asker = new Connection(world.asker, true);
  world.connections.push(asker);
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Billing migration: two calls before I cut over' })).toBeVisible();
  const foot = pane.locator('.ib-pfoot');
  const reask = foot.getByRole('button', { name: 'Re-ask', exact: true });
  await expect(reask).toBeVisible();
  // Beside Reply, the same height, on one row.
  const [reply, re] = await Promise.all([foot.getByRole('button', { name: 'Reply', exact: true }).boundingBox(), reask.boundingBox()]);
  expect(Math.abs(reply!.y - re!.y)).toBeLessThanOrEqual(1);
  expect(re!.x).toBeGreaterThan(reply!.x);
  await reask.hover();
  await expect(page.getByText('Ask Claude Code to ask the 3 open questions again, together in one message with fresh context.', { exact: false })).toBeVisible();
  await shot(page, '1-open-1440');
  await page.mouse.move(10, 10);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(300);
  await shot(page, '1-open-1280', ['light']);
  await page.setViewportSize({ width: 1440, height: 900 });

  await reask.click();
  const note = pane.locator('[data-reask-note]');
  await expect(note.locator('.ib-reask-l')).toHaveText('You asked Claude Code to ask the 3 open questions again, together in one message. They stay open here until it does.');
  await expect(reask).toHaveCount(0);
  await expect(pane.locator('[data-delivery="queued"]')).toContainText('Queued · Claude Code is working; it gets this when its turn ends.');
  await expect(pane.locator('[data-send-now]')).toBeVisible();
  await expect(pane.getByText(/^Asked again \d{1,2}:\d{2} [AP]M$/).first()).toBeVisible();
  expect(await sectionOf(world.threadId)).toBe('sent');
  await expect(page.locator(`[data-thread-id="${world.threadId}"]`).first()).toContainText('Re-ask queued for Claude Code');
  await shot(page, '2-queued-1440');
  await note.locator('summary').click();
  await expect(note.locator('pre')).toContainText('`Replaces: <id>`');
  await shot(page, '2-note-open-1440', ['light']);

  // The connection was handed the note with the Re-ask line, not the reply's.
  const command = await waitFor('the note handed to the asking session', () => asker.commands.find((c) => c.reask === true));
  const lines = inboxWakeText(command).split('\n');
  expect(lines[1]).toBe(INBOX_REASK_INSTRUCTION);
  await asker.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Claude Code, \d{1,2}:\d{2} [AP]M$/);
  expect(await sectionOf(world.threadId)).toBe('sent');
  await shot(page, '2-delivered-1440', ['light']);

  // The agent re-asks two (Replaces:) and drops the refunds one (supersedes).
  const [q1, q2, q3] = (await threadMessages(world.threadId)).find((m) => m.id === command.id)!.reask!;
  await world.claude.send(
    {
      project_path: world.billing,
      reply_to: command.id,
      supersedes: [q3!],
      body: [
        'Here are the two that still need you. The refunds question no longer applies: chargebacks moved off the legacy queue this morning.',
        '',
        q('Which table should the backfill write to first?', 'Since I asked, `invoices_v2` matches production row for row; writing `ledger_entries` first keeps the cut-over reversible.', ['ledger_entries first', 'invoices_v2 first'], 'ledger_entries first').replace(':::question\n', `:::question\nReplaces: ${q1}\n`),
        '',
        q('Do we keep the old webhook payload for a release?', 'Still two customers read `amount_cents` as a string; one deploys monthly.', ['Keep it for one release', 'Drop it now'], 'Keep it for one release').replace(':::question\n', `:::question\nReplaces: ${q2}\n`),
      ].join('\n'),
    },
    { wakes: true },
  );
  await expect(pane.getByText('Here are the two that still need you.', { exact: false })).toBeVisible();
  await expect.poll(() => sectionOf(world.threadId)).toBe('waiting');
  await expect(foot.getByRole('button', { name: 'Re-ask', exact: true })).toHaveCount(0);
  await shot(page, '3-reasked-1440', ['light']);
  // Every message open (a thread opened before them folds the older ones).
  const expand = page.getByRole('button', { name: /Expand all/ });
  if ((await expand.count()) > 0) await expand.click();
  await pane.locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(pane.locator('[data-replaced-tag]').filter({ hasText: 'Replaced' })).toHaveCount(2);
  await expect(pane.locator('[data-replaced-tag]').filter({ hasText: 'No longer applies' })).toHaveCount(1);
  await shot(page, '3-old-cards-1440');
  expect(world.errors).toEqual([]);
});

test('the session that asked ended: Re-ask asks who should ask again, and the picked session gets the note', async () => {
  const { page } = world;
  for (const c of world.connections) await c.stop();
  world.connections = [];
  // A new session asks two questions and goes away; another session is live.
  const gone = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  const asked = await gone.send({ project_path: world.billing, subject: 'Search index rebuild: two settings', body: [q('How often should the index rebuild?', 'A full rebuild takes 14 minutes.', ['Nightly', 'Every 6 hours'], 'Nightly'), '', q('Should search stay up during a rebuild?', 'Staying up needs 2 GB more disk.', ['Stay up', 'Go read-only'], 'Stay up')].join('\n') }, { wakes: true });
  await gone.close();
  const taker = new Connection('claude-session-taker', false);
  world.connections.push(taker);
  await page.goto(`${world.url}#thread=${asked.thread_id}`);
  const pane = page.locator('section.ib-pane');
  // Ended means 60 s with no sign of the session (the grace), read on the window's refresh.
  await expect(pane.locator('[data-asker-ended="live"]')).toBeVisible({ timeout: 100_000 });
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Re-ask', exact: true }).click();
  const choice = pane.locator('[data-route-choice]');
  await expect(choice.getByRole('group', { name: 'Who should ask again?' })).toBeVisible();
  await expect(choice.locator('[data-route-session="claude-session-taker"] input')).toBeFocused();
  await expect(choice.locator('[data-route-send]')).toHaveText('Ask Claude Code to re-ask');
  await shot(page, '4-ended-choice');
  await page.keyboard.press('Enter');
  const command = await waitFor('the note handed to the session picked', () => taker.commands.find((c) => c.reask === true));
  expect(command.redirected_from).toBe('Claude Code');
  expect(inboxWakeText(command).split('\n')[1]).toBe(INBOX_REASK_INSTRUCTION);
  expect(inboxWakeText(command).split('\n')[2]).toBe(inboxReaskRedirectedLine('Claude Code', command.id));
  await expect(pane.locator('[data-reask-note] .ib-reask-l')).toHaveText('You asked Claude Code (another session) to ask the 2 open questions again, together in one message. They stay open here until it does.');
  await shot(page, '4-ended-sent', ['light']);
  expect(world.errors).toEqual([]);
});

test('phone (WebKit, iPhone 15): Reply and Re-ask side by side, 44 px', async () => {
  const phoneThread = await world.claude.send({ project_path: world.billing, thread: 'release notes', subject: 'Release notes: two questions', body: [q('Ship the notes today?', 'The draft is ready.', ['Today', 'Tomorrow'], 'Today'), '', q('Mention the API change?', 'It affects two customers.', ['Yes', 'No'], 'Yes')].join('\n') }, { wakes: true });
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(`${world.url}#thread=${phoneThread.thread_id}`);
      const foot = page.locator('.ib-pfoot');
      const reask = foot.getByRole('button', { name: 'Re-ask', exact: true });
      await expect(reask).toBeVisible();
      const [reply, re] = await Promise.all([foot.getByRole('button', { name: 'Reply', exact: true }).boundingBox(), reask.boundingBox()]);
      expect(reply!.height).toBe(44);
      expect(re!.height).toBe(44);
      expect(Math.abs(reply!.y - re!.y)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(proofDir, `5-phone-${scheme}.png`) });
      await context.close();
    }
  } finally {
    await own?.close();
  }
});
