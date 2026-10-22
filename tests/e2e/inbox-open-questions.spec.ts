/**
 * Open questions in one thread (approval "inbox-thread-open-questions",
 * option A), proved in a real browser against the compiled binary. Nothing is
 * mocked: the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, and a Claude Code agent asks through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * One session asks over eight messages; the person looks, picks on one card,
 * and the agent replaces one question and asks two more. Reopened, the first
 * messages fold. The "N open questions" button sits after Re-ask, its list
 * names each question's state and place, and choosing a folded one opens its
 * message and rings its card. Then the list as a bottom sheet on a phone
 * (WebKit, iPhone 15).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop 1440 and a phone, light and dark) land in
 * PLANNOTATOR_OPEN_Q_SHOTS, or .local/proof/open-questions/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_OPEN_Q_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'open-questions'));

const q = (prompt: string, choices: string[], extra: string[] = []) => [':::question', prompt, ...extra, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');
const text = (prompt: string) => [':::question-text', prompt, ':::'].join('\n');

interface World {
  dataDir: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: string[];
}

let world: World;

function registry(): { port: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
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
  const root = inboxScratch('plannotator-inbox-open-q-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
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
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const first = await claude.send({ project_path: billing, subject: 'Retry worker for failed Stripe charges', body: `I'm adding a retry worker.\n\n${q('Which queue backs the retry worker?', ['Postgres (pg-boss)', 'Redis'])}` }, { wakes: true });
  const threadId = first.thread_id as string;
  const ids = [first.message_id as string];
  const more = [
    `Rate limits next.\n\n${q('How many times should a rate-limited charge be retried?', ['3', '5', '10'])}`,
    `I checked the 409 row against the Stripe docs.\n\n${q('Which way should the worker go on a Stripe 409?', ['Retry with the same idempotency key', 'Fail the job'], ['Stopped: the 409 branch'])}`,
    'Added structured logs for every attempt.',
    `Logging.\n\n${q('Log every attempt at info?', ['Yes', 'No'])}`,
    `The worker runs end to end in staging.\n\n${q('Ship the retry worker behind a flag?', ['Yes', 'No'], ['Holds up: the retry worker; the admin page'])}`,
  ];
  for (const body of more) ids.push((await claude.send({ project_path: billing, reply_to: first.message_id as string, body }, { wakes: true })).message_id as string);
  world = { dataDir, url, claude, context, page, errors, threadId, ids };
  // The one-time notification line is not what these shots are about.
  await fetch(`http://127.0.0.1:${registry().port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });

  // The person looks (so these fold later) and picks Yes on the flag question: it waits in the draft.
  await page.goto(`${url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Retry worker for failed Stripe charges' })).toBeVisible();
  await pane.locator(`[data-message-id="${ids[5]}"] [data-question-option]`).filter({ hasText: 'Yes' }).first().click();
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText('1 pick');
  await page.goto(`${url}#`);
  await expect(pane).toHaveCount(0);

  // The agent replaces the logging question and asks one more.
  const replaced = await claude.send({ project_path: billing, reply_to: first.message_id as string, supersedes: [ids[4]!], body: `On logging: every attempt at info is noisy.\n\n${q('Log retries at info, or at debug with a daily summary at info?', ['Info', 'Debug, with a daily summary at info'])}` }, { wakes: true });
  ids.push(replaced.message_id as string);
  ids.push((await claude.send({ project_path: billing, reply_to: first.message_id as string, body: `Draft PR is up.\n\n${text('Anything the on-call runbook should say about the retry worker?')}` }, { wakes: true })).message_id as string);
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

test('desktop: the button sits after Re-ask, its list names state and place, and a folded question opens and rings', async () => {
  const { page, ids } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Retry worker for failed Stripe charges' })).toBeVisible();
  const foot = pane.locator('.ib-pfoot');
  const button = foot.locator('[data-open-questions]');
  // 6 open: the queue, rate limits, the 409, the flag (picked), the new logging one, the runbook. The replaced one is left out.
  await expect(button).toHaveText('6 open questions');
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const reask = foot.getByRole('button', { name: 'Re-ask', exact: true });
  const [re, oq] = await Promise.all([reask.boundingBox(), button.boundingBox()]);
  expect(Math.abs(re!.y - oq!.y)).toBeLessThanOrEqual(1);
  expect(oq!.x).toBeGreaterThan(re!.x);
  // The skip chip is unchanged beside it.
  await expect(foot.locator('[data-skip-chip]')).toContainText('questions stay open');

  await button.click();
  const list = page.locator('[data-open-questions-list]');
  await expect(list).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toHaveAttribute('role', 'menu');
  await expect(list.locator('.ib-oq-head > b')).toHaveText('6 open questions in this thread');
  await expect(list.locator('.ib-oq-sub')).toHaveText('1 in your draft · 1 replaced, left out');
  const rows = list.getByRole('menuitem');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText('How many times should a rate-limited charge be retried?');
  await expect(rows.nth(1).locator('.ib-oq-when')).toHaveText(/ · in a folded message$/);
  await expect(rows.nth(2).locator('.ib-b-stop')).toHaveText('Stopped');
  await expect(rows.nth(3).locator('.ib-oq-draft')).toHaveText('Draft · Yes');
  await expect(rows.nth(5).locator('.ib-oq-when')).toHaveText(/ · (above|below)$/);
  // Inside the window, above the foot.
  const [box, pop] = await Promise.all([pane.boundingBox(), list.boundingBox()]);
  expect(pop!.y + pop!.height).toBeLessThanOrEqual(oq!.y);
  expect(pop!.x + pop!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  expect(await list.locator('[title]').count()).toBe(0);
  await page.mouse.move(10, 10);
  await shot(page, 'desktop-open');

  // Escape closes it and puts focus back on the button.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();

  // The keyboard: open, arrow to the rate-limit question, choose it.
  await page.keyboard.press('ArrowDown');
  await expect(list).toBeVisible();
  const card = pane.locator(`[data-message-id="${ids[1]}"] [data-question-key]`);
  await expect(card).toHaveCount(0);
  await rows.nth(1).click();
  await expect(list).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/ib-q-target/);
  await expect(card).toBeFocused();
  await expect(card).toBeInViewport();
  await shot(page, 'desktop-landed');
  expect(world.errors).toEqual([]);
});

test('phone (WebKit, iPhone 15): "6 open", and the list is a bottom sheet with 44 px targets', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const button = page.locator('.ib-pfoot [data-open-questions]');
      await expect(button).toHaveText('6 open');
      await expect(button).toHaveAttribute('aria-label', '6 open questions');
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await button.click();
      const list = page.locator('[data-open-questions-list]');
      await expect(list).toBeVisible();
      const viewport = page.viewportSize()!;
      const sheet = (await list.boundingBox())!;
      expect(Math.abs(sheet.y + sheet.height - viewport.height)).toBeLessThanOrEqual(1);
      expect(sheet.x).toBeLessThanOrEqual(1);
      expect(Math.abs(sheet.width - viewport.width)).toBeLessThanOrEqual(1);
      for (const row of await list.getByRole('menuitem').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const close = list.locator('[data-open-questions-close]');
      expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, `phone-open-${scheme}.png`) });
      await close.click();
      await expect(list).toHaveCount(0);
      await context.close();
    }
  } finally {
    await own?.close();
  }
});
