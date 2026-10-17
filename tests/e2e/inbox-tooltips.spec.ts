/**
 * The Inbox's hover text is ui's Tooltip component, never the browser's slow
 * native `title` (the owner, 2026-10-17: "I want an actual component
 * tooltip"). Proved in a real Chromium against the compiled binary under a
 * temp PLANNOTATOR_DATA_DIR, at 1440 by 900 with a device scale of 2 and a
 * thread open (the list's two-line rows, where the owner hovered):
 *
 * - nothing in the window carries a native title (an iframe's title is its
 *   accessible name and stays);
 * - a cut project label in a row and a sidebar project open the component
 *   tooltip within a moment, and a sidebar project's tooltip names its folder;
 * - no thread chip loses a fraction of a pixel to the subject's shrink (the
 *   chip "reconciliation-run" was drawn "reconciliation-r…" by a 0.06 px
 *   overflow), and a chip cut by a fraction of a pixel still opens its tooltip;
 * - Escape with a tooltip open still closes the thread;
 * - a disabled control still shows its tooltip (the pointer reaches its
 *   wrapper).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/tooltips/ (PLANNOTATOR_E2E_PROOF_DIR).
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tooltips');
const LONG = 'northwind-industries-holdings-platform-billing-service';

let url = '';
let threadId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-tooltips-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim().replace(/\/+$/, '');
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  try {
    const src = join(root, 'src');
    const long = scratchProject(src, LONG);
    await agent.send({ project_path: scratchProject(src, 'api'), subject: 'Rate limits on the public API', body: DEMO_MESSAGES.stopped });
    await agent.send({ project_path: long, subject: 'Ledger totals disagree after the nightly batch finished', body: DEMO_MESSAGES.holding, thread: 'reconciliation-run' });
    await agent.send({ project_path: long, subject: 'Invoices for the March close are missing their tax lines', body: 'Seen in the March close.', thread: 'invoice-tax-lines-for-the-march-close' });
    const first = await agent.send({ project_path: scratchProject(src, 'docs-site'), subject: 'Install page', body: DEMO_MESSAGES.named, thread: 'install-page' });
    threadId = first.thread_id;
  } finally {
    await agent.close().catch(() => {});
  }
});

test.afterAll(async () => {
  await removeInboxScratch();
});

/** The component tooltip open now (ui's Tooltip popup, portaled out of the window's root). */
function tooltip(page: Page) {
  return page.locator('[data-side].bg-popover');
}

async function openPage(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`${url}/#thread=${threadId}`);
  await page.waitForSelector('section.ib-pane');
  await page.waitForSelector('.ib-lbody .ib-nrow');
  return { context, page };
}

test('nothing in the window has a native title; a cut project label and a sidebar project open the component tooltip at once', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    // The whole window, ui's question card included (componentTooltips); an iframe's title is its accessible name.
    const titles = await page.evaluate(() =>
      [...document.querySelectorAll('.pn-inbox [title]')]
        .filter((el) => el.tagName !== 'IFRAME')
        .map((el) => `${el.tagName}.${el.className}: ${el.getAttribute('title')}`),
    );
    expect(titles).toEqual([]);

    // The project label of a two-line row, cut with "…".
    const label = page.locator('.ib-lbody .ib-nrow .ib-p', { hasText: LONG }).first();
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const t0 = Date.now();
    await label.hover();
    await expect(tooltip(page)).toHaveText(LONG, { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, 'list-project-label-1440.png') });
    await page.mouse.move(700, 880);
    await expect(tooltip(page)).toHaveCount(0);

    // A sidebar project: its whole name over its folder, drawn above the panes.
    const project = page.locator('.ib-side .ib-proj', { hasText: LONG });
    await project.hover();
    await expect(tooltip(page)).toContainText(LONG);
    await expect(tooltip(page)).toContainText(`/${LONG}`);
    const box = await tooltip(page).boundingBox();
    // The popup takes no pointer (it is not hoverable): let it, for this one hit test.
    const hit = await page.evaluate(
      ({ x, y }) => {
        const popup = document.querySelector<HTMLElement>('[data-side].bg-popover')!;
        popup.style.pointerEvents = 'auto';
        const top = document.elementFromPoint(x, y)?.closest('[data-side]') === popup;
        popup.style.pointerEvents = '';
        return top;
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hit, 'the tooltip is drawn on top').toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, 'sidebar-project-1440.png') });
    await page.mouse.move(700, 880);
  } finally {
    await context.close();
  }
});

test('no chip loses a fraction of a pixel to the subject, and a chip cut by a fraction of a pixel still opens its tooltip', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    const measure = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-keyt')].map((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const style = getComputedStyle(el);
          const inner = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          return { text: el.textContent, overflow: range.getBoundingClientRect().width - inner };
        }),
      );
    // Some width between the narrow list's 380 px and wide enough for every row.
    for (const width of [380, 393, 417, 452, 520, 611]) {
      await page.locator('.ib-listcol').evaluate((el, w) => ((el as HTMLElement).style.width = `${w}px`), width);
      await page.waitForTimeout(50);
      const chips = await measure();
      expect(chips.length).toBeGreaterThan(0);
      // A chip either fits or is really cut; never cut by under a pixel because the subject shrank.
      expect(chips.filter((c) => c.overflow > 0.01 && c.overflow < 1), `at ${width}px: ${JSON.stringify(chips)}`).toEqual([]);
    }
    await page.locator('.ib-listcol').evaluate((el) => ((el as HTMLElement).style.width = ''));

    // Force the owner's case: the chip's box 0.06 px narrower than its text, both integer widths equal.
    const chip = page.locator('.ib-lbody .ib-keyt', { hasText: 'reconciliation-run' }).first();
    const forced = await chip.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect().width;
      (el.parentElement as HTMLElement).style.flex = 'none';
      el.style.flex = 'none';
      el.style.maxWidth = 'none';
      el.style.width = `${text - 0.06}px`;
      return { scroll: el.scrollWidth, client: el.clientWidth };
    });
    expect(forced.scroll).toBe(forced.client);
    await chip.hover();
    await expect(tooltip(page)).toHaveText('reconciliation-run', { timeout: 1000 });
    await page.mouse.move(700, 880);
  } finally {
    await context.close();
  }
});

test("a tooltip floats like the window's other floating surfaces: no outline with Soft's float on, ui's border with it off", async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    const borderOf = async () => {
      await page.locator('.ib-side .ib-proj', { hasText: LONG }).hover();
      await expect(tooltip(page)).toBeVisible({ timeout: 1000 });
      const found = await tooltip(page).evaluate((el) => ({ inRoot: el.closest('[data-pn-tooltip-root]') !== null, border: getComputedStyle(el).borderTopColor }));
      await page.mouse.move(700, 880);
      await expect(tooltip(page)).toHaveCount(0);
      return found;
    };
    // Portaled into the window's root, so the window's tokens reach it.
    const on = await borderOf();
    expect(on.inRoot).toBe(true);
    expect(on.border).toBe('rgba(0, 0, 0, 0)');
    await page.addStyleTag({ content: '.pn-inbox, :root.light .pn-inbox { --ib-soft-float: initial !important; }' });
    const off = await borderOf();
    expect(off.border).not.toBe('rgba(0, 0, 0, 0)');
  } finally {
    await context.close();
  }
});

test('Escape with a tooltip open still closes the thread (the tooltip does not swallow the key)', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    await page.locator('section.ib-pane [data-archive]').hover();
    await expect(tooltip(page)).toBeVisible({ timeout: 1000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect(tooltip(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a wrapped control keeps its width: Mark read never spills over Archive, from 320 px to 1440 px', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    for (const width of [320, 390, 600, 810, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const boxes = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(`section.ib-pane ${sel}`)?.getBoundingClientRect() ?? null;
        const mark = box('[data-mark-read]');
        const wrap = box('[data-tip-wrap]:has(> [data-mark-read])');
        const archive = box('[data-archive]');
        const button = document.querySelector<HTMLElement>('section.ib-pane [data-mark-read]');
        const style = button ? getComputedStyle(button) : null;
        const margins = style ? parseFloat(style.marginLeft) + parseFloat(style.marginRight) : 0;
        return mark && archive && wrap && button
          ? { markRight: mark.right, wrapWidth: wrap.width, markWidth: mark.width + margins, archiveLeft: archive.left, cut: button.scrollWidth > button.clientWidth }
          : null;
      });
      expect(boxes, `the header at ${width}px`).not.toBeNull();
      expect(boxes!.markRight, `Mark read ends before Archive at ${width}px`).toBeLessThanOrEqual(boxes!.archiveLeft);
      // The wrapper is exactly as wide as the button it holds (with its margins), and the button is never squeezed.
      expect(Math.abs(boxes!.wrapWidth - boxes!.markWidth), `the wrapper at ${width}px`).toBeLessThan(0.5);
      expect(boxes!.cut, `Mark read squeezed at ${width}px`).toBe(false);
    }
  } finally {
    await context.close();
  }
});

test('a disabled control still shows its tooltip: the pointer reaches its wrapper', async ({ browser }) => {
  const { context, page } = await openPage(browser);
  try {
    const markRead = page.locator('section.ib-pane [data-mark-read]');
    await expect(markRead).toBeVisible();
    await markRead.evaluate((el) => ((el as HTMLButtonElement).disabled = true));
    await markRead.hover({ force: true });
    await expect(tooltip(page)).toBeVisible({ timeout: 1000 });
  } finally {
    await context.close();
  }
});
