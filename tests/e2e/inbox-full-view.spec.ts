/**
 * Full view for files (approval "inbox-full-view", A · Pill), proved in a real
 * browser against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME with a
 * tailscale trap first on PATH; one agent sends an HTML page, a markdown
 * plan and a screenshot in one message through `plannotator inbox mcp`;
 * Chromium (and WebKit as an iPhone) drives the window.
 *
 * Proves: an HTML file opens full screen straight into full view (the shared
 * hidden-tools choice, hidden by default): no header, no panel, no bottom
 * bar, the page fills the window and one floating bar is left; a pin and a
 * comment work as before and the count goes up; the count opens the Comments
 * sheet with its foot; Escape walks Plannotator's ladder and never leaves
 * full view; ⌘⇧X from the window and from inside the page toggles it; `]`
 * steps keep full view with the chip, and "Last file in this thread" at the
 * end; N/M opens the peek; the eye's choice is the cookie plan review reads,
 * remembered across a reload; on an iPhone the bar sits bottom right with 44
 * px targets.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-full-view.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/full-view).
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/full-view'));

const TURNKEY = `<!doctype html><meta charset="utf-8"><title>The step log</title><style>
body{margin:0;font:18px/1.5 Georgia,serif;background:#151413;color:#efe9e1}
main{max-width:1100px;margin:0 auto;padding:80px 90px}
.eyebrow{font:600 13px system-ui;letter-spacing:.2em;color:#a39d94}
h1{font-size:76px;line-height:1.02;margin:18px 0 28px}
p{font:22px/1.6 system-ui;color:#d6d0c7;max-width:820px}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:40px;padding:28px;border:1px solid #2c2a27;border-radius:16px}
.card{background:#24221f;border-radius:12px;padding:18px 20px;font:16px system-ui}
#flagged{background:#2e2619}
</style><main><div class="eyebrow">THE STEP LOG · TURNKEY VERSION</div>
<h1 id="headline">Send us your logs. Get back the record.</h1>
<p><b>No changes to how the agent works.</b> The customer switches on the activity logs their agent framework already produces, and stores sessions with us.</p>
<div class="grid"><div class="card">Activity logs</div><div class="card">We store everything, hashed</div><div class="card" id="flagged">Actions flagged; repeats and gaps caught</div></div>
<p><label>Search <input id="q" placeholder="type here"></label></p></main>`;

const PLAN = ['# Rollout plan', '', 'Ship the step log behind a flag, then to every customer.', '', '## Steps', '', '1. Turn on activity logs.', '2. Store sessions.', '3. Flag repeats and gaps.', ''].join('\n');

interface World {
  root: string;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

/** Light and dark, with reduced motion so the chip and the shots hold still. */
async function shot(page: Page, name: string, schemes: ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const pane = (page = world.page) => page.locator('[data-attachment-pane]');
const bar = (page = world.page) => page.locator('[data-full-view-bar]');
const frame = (page = world.page) => page.frameLocator('[data-attachment-pane] iframe').first();
const composer = (page = world.page) => page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-full-view-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-full-view: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'steplog');
  mkdirSync(join(project, 'site'));
  mkdirSync(join(project, 'docs'));
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'site', 'turnkey.html'), TURNKEY);
  writeFileSync(join(project, 'docs', 'rollout.md'), PLAN);
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(TURNKEY);
  writeFileSync(join(project, 'shots', 'landing.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }),
    context,
    page,
    errors,
    threadId: '',
    ids: {},
  };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'The step log: landing page, rollout and a screenshot',
    body: 'The landing page, the rollout plan and how the page looks at 900 px.',
    attachments: ['site/turnkey.html', 'docs/rollout.md', 'shots/landing.png'],
  });
  world.threadId = sent.thread_id;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  for (const a of model.attachments) world.ids[a.name] = a.id;
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

test('an HTML file opens full screen straight into full view: the page fills the window, one bar is left', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(pane().locator('.ib-vhead')).toHaveCount(0);
  await expect(pane().locator('[data-view-foot]')).toHaveCount(0);
  await expect(frame().locator('#headline')).toHaveText('Send us your logs. Get back the record.');
  // The page fills the window.
  const box = await pane().locator('iframe').first().boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  // The bar: top right, pen (armed), the count, the position, the eye.
  await expect(bar()).toHaveAttribute('role', 'toolbar');
  const barBox = (await bar().boundingBox())!;
  expect(barBox.x + barBox.width).toBeGreaterThan(1250);
  expect(barBox.y).toBeLessThan(20);
  await expect(bar().locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar().locator('[data-full-view-comments]')).toHaveAccessibleName('Comments, 0');
  await expect(bar().locator('[data-full-view-position]')).toHaveText('1/3');
  // The first full view of the session: the eye says what it does, and the live region says how the tools come back.
  await expect(bar().locator('[data-full-view-eye-label]')).toHaveText('Show tools');
  await expect(page.locator('[data-step-live]')).toHaveText(/^Tools hidden\. Press the eye or .+X to show them\.$/);
  await expect(pane().locator('[data-full-view-changed]')).toHaveCount(0);
  await shot(page, 'html-full-view');
});

test('annotating works as before: a pin opens the composer, Save adds a marker and the count goes up', async () => {
  const page = world.page;
  await frame().locator('#flagged').click();
  await composer().fill('"Repeats" reads like duplicate charges to a claims team. Say "repeated tool calls".');
  await shot(page, 'html-full-view-annotating', ['dark']);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(bar().locator('[data-full-view-comments]')).toHaveAccessibleName('Comments, 1');
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('the count opens the Comments sheet over the file, its foot with Write the reply; Escape closes it, full view stays', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-comments]').click();
  await expect(pane()).toHaveClass(/ib-panel-open/);
  const foot = pane().locator('[data-full-view-foot]');
  await expect(foot).toContainText('1 annotation rides your next Send to Claude.');
  await expect(foot.getByRole('button', { name: 'Write the reply' })).toBeVisible();
  // The bar steps left of the sheet.
  const sheet = (await pane().locator('.ib-apanel').boundingBox())!;
  const barBox = (await bar().boundingBox())!;
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(sheet.x);
  await shot(page, 'comments-sheet', ['dark', 'light']);
  await page.keyboard.press('Escape');
  await expect(pane()).not.toHaveClass(/ib-panel-open/);
  await expect(bar().locator('[data-full-view-comments]')).toBeFocused();
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('Escape walks the ladder (draft, then Interact) and never leaves full view; ⌘⇧X from the window and from the page toggles it', async () => {
  const page = world.page;
  await frame().locator('#headline').click();
  await expect(composer()).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await frame().locator('body').press('Escape');
    await page.waitForTimeout(120);
  }
  await expect(composer()).toHaveCount(0);
  await expect(bar().locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'false');
  await expect(pane()).toHaveAttribute('data-full-view', '');
  // From the window: the tools come back, focus on the header's eye.
  await bar().locator('[data-full-view-eye]').focus();
  await page.keyboard.press('ControlOrMeta+Shift+X');
  await expect(pane()).not.toHaveAttribute('data-full-view', '');
  await expect(pane().locator('.ib-vhead [data-html-tools-toggle]')).toBeFocused();
  await expect(pane().getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await expect(page.locator('[data-step-live]')).toHaveText('Tools shown.');
  // From inside the page (Interact: the page has the keyboard).
  await frame().locator('#q').click();
  await frame().locator('#q').press('ControlOrMeta+Shift+X');
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(bar().locator('[data-full-view-eye]')).toBeFocused();
  await expect(page.locator('[data-step-live]')).toHaveText(/^Tools hidden\. Press .+X or the eye to bring them back\.$/);
  // Re-arm with the bar's pen for the rest.
  await bar().locator('[data-full-view-pen]').click();
  await expect(bar().locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'true');
});

test('] steps keep full view: the chip names the new file, markdown and the image fill the window, "Last file" at the end', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-eye]').focus();
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  const chip = pane().locator('[data-full-view-chip]');
  await expect(chip).toHaveAttribute('data-full-view-chip', 'shown');
  await expect(chip).toContainText('2 of 3');
  await expect(chip).toContainText('rollout.md');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, 'step-chip-dark.png') });
  await expect(chip).toHaveAttribute('data-full-view-chip', 'hidden', { timeout: 4000 });
  await expect(pane().locator('.ib-docscroll')).toContainText('Ship the step log behind a flag');
  // Markdown has no pen.
  await expect(bar().locator('[data-full-view-pen]')).toHaveCount(0);
  await shot(page, 'markdown-full-view');
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['landing.png']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(chip).toHaveAttribute('data-full-view-chip', 'hidden', { timeout: 4000 });
  await shot(page, 'image-full-view');
  await page.keyboard.press(']');
  await expect(chip).toContainText('Last file in this thread');
});

test('N/M opens the file peek under the bar; a pick goes there and full view stays', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-position]').click();
  const grid = bar().locator('[data-step-list] [role="grid"]');
  await expect(grid).toBeVisible();
  await shot(page, 'peek', ['dark']);
  await grid.getByRole('gridcell', { name: /^turnkey\.html/ }).click();
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['turnkey.html']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(bar().locator('[data-full-view-position]')).toBeFocused();
});

test('the eye is the choice plan review shares: shown is remembered across a reload, and hidden again', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-eye]').click();
  await expect(pane()).not.toHaveAttribute('data-full-view', '');
  const cookie = (await world.context.cookies(world.url)).find((c) => c.name === 'plannotator-html-chrome');
  expect(JSON.parse(decodeURIComponent(cookie!.value)).toolsHidden).toBe(false);
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  await expect(pane().locator('.ib-vhead [data-html-tools-toggle]')).toBeVisible();
  await expect(pane()).not.toHaveAttribute('data-full-view', '');
  await pane().locator('.ib-vhead [data-html-tools-toggle]').click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  const again = (await world.context.cookies(world.url)).find((c) => c.name === 'plannotator-html-chrome');
  expect(JSON.parse(decodeURIComponent(again!.value)).toolsHidden).toBe(true);
  expect(world.errors).toEqual([]);
});

test('a file that changed since it was sent says so in full view: the chip at the top left opens the version it sent', async () => {
  const page = world.page;
  writeFileSync(join(world.project, 'docs', 'rollout.md'), PLAN.replace('Ship the step log', 'Hold the step log'));
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await bar().locator('[data-full-view-eye]').focus();
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
  const changed = pane().locator('[data-full-view-changed]');
  await expect(changed.locator('.ib-fvver-t')).toHaveText('Changed since sent');
  await expect(pane().locator('.ib-docscroll')).toContainText('Hold the step log');
  await page.waitForTimeout(1800);
  await shot(page, 'markdown-changed-full-view', ['dark']);
  await changed.getByRole('button', { name: 'Open the version it sent' }).click();
  await expect(changed.locator('.ib-fvver-t')).toHaveText('Showing the sent version');
  await expect(pane().locator('.ib-docscroll')).toContainText('Ship the step log');
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('on an iPhone (WebKit): full view with the bar bottom right, 44 px targets; the count opens the sheet with the position', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext({ ...device, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await page.getByRole('button', { name: 'Open turnkey.html' }).click();
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    await expect(frame(page).locator('#headline')).toBeVisible();
    const viewport = page.viewportSize()!;
    const barBox = (await bar(page).boundingBox())!;
    expect(barBox.x + barBox.width).toBeGreaterThan(viewport.width - 40);
    expect(barBox.y + barBox.height).toBeGreaterThan(viewport.height - 80);
    for (const control of ['[data-full-view-pen]', '[data-full-view-comments]', '[data-full-view-eye]']) {
      const b = (await bar(page).locator(control).boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await expect(bar(page).locator('[data-full-view-position]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, 'phone-full-view-dark.png') });
    await bar(page).locator('[data-full-view-comments]').click();
    await expect(pane(page).locator('[data-full-view-foot] [data-full-view-position]')).toContainText('1 of 3');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, 'phone-comments-dark.png') });
    await context.close();
  } finally {
    await browser.close();
  }
});
