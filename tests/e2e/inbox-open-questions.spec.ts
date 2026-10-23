/**
 * Open questions in one thread (approval "inbox-thread-open-questions",
 * option A), proved in a real browser against the compiled binary. Nothing is
 * mocked: the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, and a Claude Code agent asks through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * One session asks over eight messages; the person looks, picks on one card,
 * and the agent replaces one question and asks two more. Reopened, the first
 * messages fold. The "N open questions" button sits after Edit draft (no
 * Re-ask button in the foot: Re-ask is the list's last item, owner,
 * 2026-10-23), its list names each question's state and place with no drawn
 * heading or foot line, and choosing a folded one opens its
 * message and rings its card. Then the list as a bottom sheet on a phone
 * (WebKit, iPhone 15). Then the foot's buttons on one row with a pick waiting
 * (beside a file at 1100, 1280 and 1440, and on phones), and the "N new" pill
 * on a phone never lying over a foot button.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop 1440 and a phone, light and dark) land in
 * PLANNOTATOR_OPEN_Q_SHOTS, or .local/proof/open-questions/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  billing: string;
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

/**
 * Every button in the foot's row shares one line, inside the foot: the open questions button never drops to a
 * row of its own (review of PR #2091).
 */
async function expectOneRow(page: Page): Promise<void> {
  const buttons = page.locator('section.ib-pane .ib-pfoot [data-foot-buttons]');
  await expect(buttons.locator('[data-open-questions]')).toBeVisible();
  // Polled: a file opening springs the pane's width, and the row is fitted again on each frame of it.
  await expect(async () => {
    const { boxes, rowRight } = await buttons.evaluate((row) => ({
      boxes: [...row.children]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? '').trim(), top: Math.round(r.top), right: r.right };
        }),
      rowRight: row.parentElement!.getBoundingClientRect().right,
    }));
    // At least Reply (or Send and Edit draft) and the open questions button (Re-ask is in its list).
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(boxes.map((b) => b.top)).size, JSON.stringify(boxes)).toBe(1);
    for (const b of boxes) expect(b.right, JSON.stringify({ boxes, rowRight })).toBeLessThanOrEqual(rowRight + 0.5);
  }).toPass({ timeout: 5000 });
}

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function attachmentId(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${world.threadId}/attachments`);
  const body = (await res.json()) as { attachments: { id: string; name: string }[] };
  const att = body.attachments.find((a) => a.name === 'runbook.md');
  expect(att, JSON.stringify(body)).toBeTruthy();
  return att!.id;
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
  world = { dataDir, url, claude, context, page, errors, threadId, ids, billing };
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
  // The runbook draft rides along, so the thread can show a file beside it.
  writeFileSync(join(billing, 'runbook.md'), '# Retry worker runbook\n\nWhat on-call does when charges pile up in the retry queue.\n');
  ids.push((await claude.send({ project_path: billing, reply_to: first.message_id as string, attachments: ['runbook.md'], body: `Draft PR is up.\n\n${text('Anything the on-call runbook should say about the retry worker?')}` }, { wakes: true })).message_id as string);
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

test('desktop: the button sits after Edit draft, its list names state and place and ends with Re-ask, and a folded question opens and rings', async () => {
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
  await expect(foot.getByRole('button', { name: 'Re-ask', exact: true })).toHaveCount(0);
  const edit = foot.getByRole('button', { name: 'Edit draft', exact: true });
  const [re, oq] = await Promise.all([edit.boundingBox(), button.boundingBox()]);
  expect(Math.abs(re!.y - oq!.y)).toBeLessThanOrEqual(1);
  expect(oq!.x).toBeGreaterThan(re!.x);
  // The skip chip is unchanged beside it.
  await expect(foot.locator('[data-skip-chip]')).toContainText('questions stay open');

  await button.click();
  const list = page.locator('[data-open-questions-list]');
  await expect(list).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toHaveAttribute('role', 'menu');
  // Named, not titled: no drawn heading, count line or foot line.
  await expect(list).toHaveAttribute('aria-label', '6 open questions in this thread');
  await expect(list).not.toContainText('in this thread');
  await expect(list).not.toContainText('Choose one');
  const rows = list.locator('.ib-oq-row');
  await expect(rows).toHaveCount(6);
  // Re-ask is the last menu item.
  await expect(list.getByRole('menuitem')).toHaveCount(7);
  await expect(list.getByRole('menuitem').last()).toHaveText('Re-ask in one new message');
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

test('phone (WebKit, iPhone 15) with a pick waiting: the buttons on one row, and the list is a bottom sheet with 44 px targets', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const button = page.locator('.ib-pfoot [data-open-questions]');
      // A pick waits: Send, Edit draft and this button share one row, so the label is as short as it must be.
      await expect(page.locator('.ib-pfoot [data-foot-status] [data-draft-foot]')).toContainText('1 pick');
      await expect(button).toHaveText(/^6( open)?$/);
      await expect(button).toHaveAttribute('aria-label', '6 open questions');
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expectOneRow(page);
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

test('beside a file (the 440 px thread column) with a pick waiting: every foot button on one row', async () => {
  const { page } = world;
  const att = await attachmentId();
  for (const width of [1100, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${world.url}#thread=${world.threadId}&file=${att}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane).toHaveClass(/ib-withfile/);
    await expect(pane.locator('.ib-pfoot [data-foot-status] [data-draft-foot]')).toContainText('1 pick');
    const button = pane.locator('.ib-pfoot [data-open-questions]');
    // Without a Re-ask button beside it (it is in the list now) the full words may fit; the name is whole either way.
    await expect(button).toHaveAccessibleName('6 open questions');
    await expect(button).toHaveText(/^6( open)?( questions)?$/);
    await expectOneRow(page);
    if (width === 1280) {
      await page.mouse.move(10, 10);
      await shot(page, 'fix-desktop-file-1280');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Without a file the full words come back.
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('section.ib-pane .ib-pfoot [data-open-questions]')).toHaveText('6 open questions');
  expect(world.errors).toEqual([]);
});

test('phone (Chromium, Pixel 7) with a pick waiting: every foot button on one row', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await expect(page.locator('.ib-pfoot [data-foot-status] [data-draft-foot]')).toContainText('1 pick');
    await expect(page.locator('.ib-pfoot [data-open-questions]')).toHaveAttribute('aria-label', '6 open questions');
    await expectOneRow(page);
    await shot(page, 'fix-phone-412-pick');
  } finally {
    await context.close();
  }
});

test('phone (Chromium, Pixel 7): the "N new" pill never lies over a foot button', async ({ browser }: { browser: Browser }) => {
  // A thread the person never looked at: every message is new, and it opens at the top with the rest below.
  const long = (n: number) =>
    Array.from({ length: 8 }, (_, i) => `Step ${n}.${i + 1}: the retry worker reads the charge, checks the idempotency key and writes the attempt row before it calls Stripe.`).join('\n\n');
  const send = (body: string, extra: { subject?: string; thread?: string; reply_to?: string }) => world.claude.send({ project_path: world.billing, body, ...extra }, { wakes: true });
  const first = await send(`${long(1)}\n\n${q('Which region goes first?', ['us-east', 'eu-west'])}`, { subject: 'Refund worker rollout', thread: 'refund-rollout' });
  const reply_to = first.message_id as string;
  await send(`${long(2)}\n\n${q('Page on-call for refund failures?', ['Yes', 'No'])}`, { reply_to });
  await send(long(3), { reply_to });
  await send(long(4), { reply_to });
  const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${first.thread_id as string}`);
    const foot = page.locator('.ib-pfoot');
    // Reply and "2 open" (Re-ask is in its list): the pill keeps clear of them.
    await expect(foot.locator('[data-open-questions]')).toHaveAttribute('aria-label', '2 open questions');
    await expect(foot.getByRole('button', { name: 'Re-ask', exact: true })).toHaveCount(0);
    const pill = page.locator('[data-new-pill]');
    await expect(pill).not.toHaveAttribute('data-off', '');
    await expect(pill).toBeVisible();
    await expectOneRow(page);
    const pillBox = (await pill.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(pillBox.y).toBeGreaterThanOrEqual(0);
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(viewport.height);
    for (const b of await foot.locator('[data-foot-buttons] button').all()) {
      const box = (await b.boundingBox())!;
      expect(intersects(pillBox, box), `pill ${JSON.stringify(pillBox)} over ${(await b.textContent())?.trim()} ${JSON.stringify(box)}`).toBe(false);
    }
    await shot(page, 'fix-phone-412-pill');
    // The pill still works: it takes the person down to the new messages.
    const scrolled = () => page.locator('.ib-pbody').evaluate((el) => el.scrollTop);
    const before = await scrolled();
    await pill.click();
    await expect.poll(scrolled).toBeGreaterThan(before);
    expect(world.errors).toEqual([]);
  } finally {
    await context.close();
  }
});
