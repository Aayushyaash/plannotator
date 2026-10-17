/**
 * Queued, Sending, Send now (the owner's request, 2026-10-16: "The message
 * should be less deceiving. It should say this message is queued up or
 * something. And then maybe an option just to send it immediately."),
 * proved in a real browser against the compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME; a Claude Code agent writes through
 * `plannotator inbox mcp` with the wake meta (scripts/inbox-sim.ts), as the
 * mod does; its connection is the bridge's real doors driven as the mod
 * drives them (the bearer token from inbox.json, a long-poll saying where the
 * session works, whether a turn runs and that it can take a reply mid-turn,
 * `delivered` once the reply is in); the person's Send is the window's own
 * reply box. The mod's own code doing the delivery is
 * apps/hook/hooks/mod/inbox.test.ts (12, 13).
 *
 * PNGs (light, dark, and a phone) land in .local/proof/send-now/, or in
 * PLANNOTATOR_SEND_NOW_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_SEND_NOW_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'send-now'));

interface World {
  dataDir: string;
  env: Record<string, string>;
  url: string;
  ledger: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One Claude Code session's connection, as the mod runs it: busy or idle, and able to take a reply mid-turn. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private busy: boolean,
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
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: world.ledger,
        started_at: Date.now() - 30 * 60_000,
        busy: this.busy,
        idle_since: Date.now() - 60_000,
        [INBOX_SEND_NOW_POLL_FIELD]: true,
      }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        const known = this.commands.findIndex((c) => c.id === command.id);
        if (known < 0) this.commands.push(command);
        else this.commands[known] = command;
      }
      await new Promise((r) => setTimeout(r, 200));
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

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-send-now-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
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
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, env, url, ledger, agent, context, page, errors, connections: [] };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.agent.close().catch(() => {});
    for (const agent of extraAgents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/** A Claude Code session of its own (one `plannotator inbox mcp` process is one session): its message starts its own thread. */
async function freshAgent(): Promise<SimAgent> {
  const agent = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  extraAgents.push(agent);
  return agent;
}
const extraAgents: SimAgent[] = [];

async function sessionOf(threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  const thread = ((await response.json()) as { thread: { messages: { author: { session: string } }[] } }).thread;
  return thread.messages[0]!.author.session;
}

/** The person replies in the window: Reply, type, Send. */
async function replyInWindow(page: Page, words: string): Promise<void> {
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  const box = pane.getByRole('textbox', { name: 'Reply to Claude Code' });
  await box.fill(words);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(pane.locator('article.ib-message[data-author="person"]').last()).toContainText(words);
}

test('Claude Code at work: the reply reads "Queued · … is working" with Send now; pressing it hands the reply over with `now`, then Delivered', async () => {
  const { page } = world;
  const sent = await world.agent.send(
    { project_path: world.ledger, subject: 'Migration shipped', body: 'The ledger migration is shipped and the backfill is running. Anything else before I move on to the export?' },
    { wakes: true },
  );
  const session = await sessionOf(sent.thread_id);
  const connection = new Connection(session, true);
  world.connections.push(connection);

  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Migration shipped' })).toBeVisible();
  await replyInWindow(page, 'Yes: bump the version and add a changelog line before the export.');

  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveAttribute('data-delivery', 'queued');
  await expect(line).toContainText('Queued · Claude Code is working; it gets this when its turn ends.');
  const button = pane.locator('[data-send-now]');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Send now');
  await expect(page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"]`).first()).toContainText('Queued for Claude Code; it gets this as its next turn.');
  // Handed out without `now` while nobody pressed it.
  await expect.poll(() => connection.commands.length, { timeout: 15_000 }).toBe(1);
  expect(connection.commands[0]!.now).toBeUndefined();
  await shot(page, '1-queued-working');

  await button.click();
  await expect(line).toHaveAttribute('data-delivery', 'sending');
  await expect(line).toHaveText('Sending to Claude Code now…');
  await expect(button).toHaveCount(0);
  await expect.poll(() => connection.commands[0]?.now, { timeout: 15_000 }).toBe(true);
  await shot(page, '2-sending-now');

  // The connection put it into the running turn.
  await connection.deliver(connection.commands[0]!.id);
  await expect(line).toHaveAttribute('data-delivery', 'delivered');
  await expect(line).toHaveText(/^Delivered to Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  await shot(page, '3-delivered');
});

test('idle: "Sending to Claude Code…", no Send now', async () => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Export streams now', body: 'The export streams rows now. Peak memory went from 1.9 GB to 140 MB.' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), false);
  world.connections.push(connection);
  // A fresh load: a thread that arrived while another was open waits behind "N new" in the list.
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Export streams now' })).toBeVisible();
  await replyInWindow(page, 'Great. Post the numbers in the PR.');
  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveAttribute('data-delivery', 'sending');
  await expect(line).toHaveText('Sending to Claude Code…');
  await expect(pane.locator('[data-send-now]')).toHaveCount(0);
  await shot(page, '4-sending-idle');
});

test('an MCP-only agent: "Saved for … It sees it when it next reads this thread", no Send now; the list row says the same', async () => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Docs pass done', body: 'The docs pass is done.' });
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Docs pass done' })).toBeVisible();
  await replyInWindow(page, 'Thanks.');
  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveText('Saved for Claude Code. It sees it when it next reads this thread.');
  await expect(pane.locator('[data-send-now]')).toHaveCount(0);
  await expect(page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"]`).first()).toContainText('Saved for Claude Code. It sees it when it next reads this thread.');
  await shot(page, '5-saved-mcp-only');
  expect(world.errors).toEqual([]);
});

test('on a phone: the queued line and Send now fit, and the button has a 44 px target', async ({ browser }) => {
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Tests green', body: 'All tests are green on the branch.' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), true);
  world.connections.push(connection);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: 'Tests green' })).toBeVisible();
    await replyInWindow(page, 'Merge it.');
    await expect(pane.locator('[data-delivery]')).toContainText('is working');
    const button = pane.locator('[data-send-now]');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const target = await button.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      const rect = el.getBoundingClientRect();
      return rect.height + parseFloat(after.top === 'auto' ? '0' : after.top) * -1 + parseFloat(after.bottom === 'auto' ? '0' : after.bottom) * -1;
    });
    expect(target).toBeGreaterThanOrEqual(44);
    await shot(page, '6-phone-queued');
  } finally {
    await context.close();
  }
});
