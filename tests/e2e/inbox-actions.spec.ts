/**
 * Action items an agent needs the person to go do (approval "inbox-next-actions",
 * 2026-10-21, direction "In the thread"), proved in a real browser against the
 * compiled binary, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - an agent's `:::action` block with `Stopped:` puts its thread under
 *    Stopped on you, and the row reads "1 action item" ("1 question, 1 action item" beside
 *    a question): no new section, page or strip;
 *  - the thread draws the checklist card in place of the block (approval
 *    "action-items-checklist", option A): adjacent blocks are one card, blocks
 *    separated by prose are two; one row open at a time; the open row shows
 *    why, the Holds up words, Open for its link and the whole command with
 *    Copy (both when an item has both), then Done / Can't do it… / Add note…;
 *  - Done: the toast with Undo, the row's Undo while the window runs, the next
 *    open item opens, then the agent's wait_for_reply returns the reply with
 *    "Action items you asked for" and the row reads Sent;
 *  - Can't do it asks for the reason, which the agent gets word for word;
 *  - the agent marks its own action item done (`done`): the card reads "Claude Code
 *    saw it done" and nothing is sent;
 *  - light and dark, desktop and a phone (WebKit, iPhone 15: 44 px targets).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/actions/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'actions');

const VERCEL = [
  'Release 4.2 is built and every check passed.',
  '',
  ':::action',
  'Approve the production deploy on Vercel',
  'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
  '',
  'Where: [Vercel](https://vercel.com/acme/web/deployments/dpl_8Hk2mQ)',
  'Stopped: release 4.2 cannot go out until it is approved',
  "Watching: the deployment; I go on by myself once it is Ready",
  ':::',
].join('\n');

const NPM = [
  'The publish failed with E401.',
  '',
  ':::action',
  'Sign in to npm in your terminal',
  'The token on this machine expired; npm wants a browser sign-in with your security key.',
  '',
  'Run: `npm login`',
  'Holds up: the 0.29 publish',
  ':::',
  '',
  ':::question',
  'Publish 0.29 as latest, or as next first?',
  '',
  '- [ ] latest',
  '- [ ] next first',
  '',
  'Recommended: next first',
  ':::',
].join('\n');

const MERGE = [
  ':::action',
  'Merge PR #1937 on GitHub',
  'Branch protection needs a maintainer; I cannot merge it.',
  'Where: https://github.com/acme/web/pull/1937',
  'Watching: the PR; I go on once it is merged',
  ':::',
].join('\n');

const LONG_RUN = 'cd ~/workspaces/projects/appnotes/worktrees/main && npx wrangler secret put APPNOTES_GITHUB_APP_PRIVATE_KEY --env staging < ~/Downloads/appnotes-staging.private-key.pem && rm ~/Downloads/appnotes-staging.private-key.pem';

const STAGING = [
  'These are secrets, so only you can do them.',
  '',
  ':::action',
  'Set the GitHub App client secret on staging',
  'On the App\'s page, click "Generate a new client secret" and copy it.',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  'Run: `pbpaste | npx wrangler secret put APPNOTES_GITHUB_APP_CLIENT_SECRET --env staging`',
  'Holds up: staging sign-in with GitHub',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  ':::action',
  'Set the GitHub App private key on staging',
  'On the same page, click "Generate a private key".',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  `Run: \`${LONG_RUN}\``,
  'Holds up: the agent opening PRs on staging',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  'Then, once both are set:',
  '',
  ':::action',
  'Approve the staging deploy on Vercel',
  'Where: https://vercel.com/acme/appnotes/deployments',
  ':::',
].join('\n');

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { vercel: string; npm: string; merge: string; mergeMessage: string; mergeKey: string; staging: string };
}

let world: World;

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const row = (page: Page, threadId: string) => page.locator(`[data-thread-id="${threadId}"]`).first();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-actions-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
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
  const project = scratchProject(join(root, 'src'), 'web');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const npm = await claude.send({ project_path: project, thread: 'publish', body: NPM });
  const merge = await claude.send({ project_path: project, thread: 'merge', body: MERGE });
  const vercel = await claude.send({ project_path: project, thread: 'release', body: VERCEL });
  const staging = await claude.send({ project_path: project, thread: 'staging', body: STAGING });
  const mergeKey = ((merge.actions as { key: string }[] | undefined) ?? [])[0]?.key ?? '';
  expect(mergeKey).toMatch(/^a-[0-9a-f]{8}$/);
  world = {
    root,
    url,
    claude,
    context,
    page,
    errors,
    threads: {
      vercel: vercel.thread_id as string,
      npm: npm.thread_id as string,
      merge: merge.thread_id as string,
      mergeMessage: merge.message_id as string,
      mergeKey,
      staging: staging.thread_id as string,
    },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the list: no new section; the action item sits in Stopped on you and its row says "1 action item"', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  const stopped = page.locator('section[aria-label="Stopped on you"], .ib-group').filter({ hasText: 'Stopped on you' }).first();
  await expect(stopped).toContainText('Approve the production deploy on Vercel');
  await expect(row(page, threads.vercel)).toContainText('1 action item');
  await expect(row(page, threads.npm)).toContainText('1 question, 1 action item');
  await expect(row(page, threads.staging)).toContainText('3 action items');
  // No "Action item" section band, page or strip.
  await expect(page.getByText('Action item', { exact: true })).toHaveCount(0);
  await shot(page, '01-list');
});

test('the thread draws the checklist in place of the block: the open row shows why, the Holds up words, Open and the command', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.vercel}`);
  const card = page.locator('section.ib-pane [data-action-group]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 thing only you can do');
  await expect(card.locator('[data-action-progress]')).toHaveText('0 of 1 done');
  await expect(card.locator('[data-action-badge]')).toHaveText('Stopped');
  await expect(card.locator('[data-action-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('[data-action-stopped]')).toHaveText('Stopped release 4.2 cannot go out until it is approved');
  await expect(card.locator('[data-action-open]')).toHaveAttribute('href', 'https://vercel.com/acme/web/deployments/dpl_8Hk2mQ');
  await expect(card.locator('[data-action-watching]')).toHaveText('Claude Code is watching: the deployment; I go on by myself once it is Ready.');
  await expect(card.locator('[data-action-hint]')).toHaveText('Done reaches Claude Code after 10 s, so you can undo.');
  // The block's own lines are not drawn beside the card.
  await expect(page.locator('section.ib-pane')).not.toContainText('Where: [Vercel]');
  // 👍 Looks good waits while the action item does.
  await expect(page.locator('section.ib-pane [data-ack]')).toHaveCount(0);
  await shot(page, '02-thread-open');
  await page.goto(`${world.url}#thread=${threads.npm}`);
  const npm = page.locator('section.ib-pane [data-action-group]');
  await expect(npm.locator('[data-action-cmd]')).toContainText('npm login');
  await expect(npm.locator('[data-action-badge]')).toHaveText('Holds up 1');
  await expect(npm.locator('[data-action-holds]')).toHaveText('Holds up the 0.29 publish');
  await expect(page.locator('section.ib-pane [data-question-key]').first()).toBeVisible();
  await shot(page, '03-thread-run-and-question');
});

test('adjacent action items are one checklist, one row open at a time; prose between them makes two; Open and the whole command both show', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.staging}`);
  const groups = page.locator('section.ib-pane [data-action-group]');
  await expect(groups).toHaveCount(2);
  const first = groups.nth(0);
  await expect(first.locator('[data-action-card]')).toHaveCount(2);
  await expect(groups.nth(1).locator('[data-action-card]')).toHaveCount(1);
  await expect(first).toContainText('2 things only you can do');
  await expect(first.locator('[data-action-badge]')).toHaveText('Holds up 2');
  const rows = first.locator('[data-action-card]');
  const toggle = (i: number) => rows.nth(i).locator('[data-action-toggle]');
  await expect(toggle(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(1)).toHaveAttribute('aria-expanded', 'false');
  // One open at a time.
  await toggle(1).click();
  await expect(toggle(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(0)).toHaveAttribute('aria-expanded', 'false');
  const open = rows.nth(1);
  await expect(open.locator('[data-action-open]')).toHaveText('Open github.com');
  await expect(open.locator('[data-action-copy]')).toBeVisible();
  await expect(open.locator('[data-action-holds]')).toHaveText('Holds up the agent opening PRs on staging');
  // The command whole: every character, wrapped, nothing cut or scrolled away.
  const cmd = open.locator('[data-action-cmd]');
  expect((await cmd.textContent())!.replace(/^\$\s/, '')).toBe(LONG_RUN);
  const fit = await cmd.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.lines).toBeGreaterThan(1);
  await toggle(0).click();
  await shot(page, '03b-checklist');
});

test('Done: the toast and the row offer Undo; the next open item opens; then the agent gets the reply with "Action items you asked for" and the row reads Sent', async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.vercel}`);
  const card = page.locator('section.ib-pane [data-action-card]');
  await card.locator('[data-action-note]').click();
  await card.locator('textarea').fill('Approved. I also fixed the preview env var while I was there.');
  await card.locator('[data-action-done]').click();
  await expect(card).toHaveAttribute('data-action-state', 'pending');
  await expect(card.locator('[data-action-settled]')).toContainText('Goes to Claude Code in a few seconds.');
  await expect(card.locator('[data-action-undo]')).toBeVisible();
  await expect(page.locator('.ib-toast')).toContainText('Goes to Claude Code in 10 s');
  await shot(page, '04-done-pending');
  const answer = await claude.waitForReply(threads.vercel, 40);
  expect(answer.status).toBe('replied');
  const body = (answer.reply as { body: string }).body;
  expect(body.startsWith('Did 1 action item.\n\n## Action items you asked for\n\n1 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nDone, ')).toBe(true);
  expect(body.endsWith('\nNote: Approved. I also fixed the preview env var while I was there.')).toBe(true);
  await expect(card).toHaveAttribute('data-action-state', 'done', { timeout: 20_000 });
  await expect(card.locator('.ib-badge')).toHaveText('Done');
  await expect(card.locator('[data-action-tick]')).toHaveCount(0);
  await card.locator('[data-action-toggle]').click();
  await expect(card.locator('[data-action-settled]')).toContainText('Sent to Claude Code.');
  await expect(card.locator('[data-action-done]')).toHaveCount(0);
  await shot(page, '05-done-sent');
});

test("the row's tick is Done: the row is struck with its Undo and the next open item opens", async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.staging}`);
  const rows = page.locator('section.ib-pane [data-action-group]').first().locator('[data-action-card]');
  await rows.nth(0).locator('[data-action-tick]').click();
  await expect(rows.nth(0)).toHaveAttribute('data-action-state', 'pending');
  await expect(rows.nth(1).locator('[data-action-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('section.ib-pane [data-action-group]').first().locator('[data-action-progress]')).toHaveText('1 of 2 done');
  await shot(page, '05b-tick-done', ['light']);
  await rows.nth(0).locator('[data-action-undo]').click();
  await expect(rows.nth(0)).toHaveAttribute('data-action-state', 'open');
});

test("Can't do it: the reason, word for word", async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.npm}`);
  const card = page.locator('section.ib-pane [data-action-card]');
  await card.locator('[data-action-cant]').click();
  await expect(card.locator('[data-action-cant-send]')).toBeDisabled();
  await card.locator('textarea').fill('No security key here; I am on my phone until tonight.');
  await shot(page, '06-cant-reason');
  await card.locator('[data-action-cant-send]').click();
  const answer = await claude.waitForReply(threads.npm, 40);
  expect((answer.reply as { body: string }).body).toContain("### A1. Sign in to npm in your terminal\nCan't do it: No security key here; I am on my phone until tonight.");
  await expect(card).toHaveAttribute('data-action-state', 'cant', { timeout: 20_000 });
  await expect(card.locator('[data-action-settled]')).toHaveText("Can't do it: “No security key here; I am on my phone until tonight.” Sent to Claude Code.");
  await shot(page, '07-cant-sent');
});

test('the agent marks its own action item done: the card says so, nothing is sent', async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.merge}`);
  const card = page.locator('section.ib-pane [data-action-card]');
  await expect(card).toHaveAttribute('data-action-state', 'open');
  const sent = await claude.send({
    project_path: world.root,
    reply_to: threads.mergeMessage,
    body: 'The PR is merged, so I marked the action item done. Running the release smoke tests now.',
    done: [`${threads.mergeMessage}/${threads.mergeKey}`],
  });
  expect(sent.done).toEqual([`${threads.mergeMessage}/${threads.mergeKey}`]);
  await expect(card).toHaveAttribute('data-action-state', 'seen', { timeout: 20_000 });
  await card.locator('[data-action-toggle]').click();
  await expect(card.locator('[data-action-settled]')).toContainText('Claude Code saw it done');
  await shot(page, '08-agent-saw-it-done');
  const thread = await claude.readThread(threads.merge);
  // Nothing from the person: the agent's two messages only.
  expect((thread.messages as { author: { kind: string } }[]).every((m) => m.author.kind === 'agent')).toBe(true);
  expect(world.errors).toEqual([]);
});

test('phone (WebKit, iPhone 15): the checklist, 44 px targets', async () => {
  let own: Browser | null = null;
  try {
    const project = scratchProject(join(world.root, 'phone'), 'mobile');
    const sent = await world.claude.send({ project_path: project, thread: 'phone', body: VERCEL.replace('4.2', '4.3') });
    own = await webkit.launch({ args: [] });
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id as string}`);
    const card = page.locator('section.ib-pane [data-action-card]');
    await expect(card).toBeVisible();
    for (const selector of ['[data-action-done]', '[data-action-cant]', '[data-action-note]', '[data-action-open]']) {
      expect((await card.locator(selector).boundingBox())!.height).toBe(44);
    }
    for (const selector of ['[data-action-tick]', '[data-action-toggle]']) {
      const box = (await card.locator(selector).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await shot(page, '09-phone');
    await context.close();
  } finally {
    await own?.close();
  }
});
