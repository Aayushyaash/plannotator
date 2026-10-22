/**
 * The remembered file view (packages/inbox/fileView.ts) in specs that share
 * one browser context across serial tests: pressing "Side by side" or "Full
 * screen" saves the choice in a cookie, which would change how every later
 * test's files open. Specs that press them only to get somewhere call this
 * right after, so the next test starts with today's rule again; the toast the
 * pick raised goes too, so it covers nothing a later click aims at.
 */
import type { Page } from '@playwright/test';

export const FILE_VIEW_COOKIE = 'plannotator-inbox-file-view';

export async function forgetFileViewChoice(page: Page): Promise<void> {
  await page.context().clearCookies({ name: FILE_VIEW_COOKIE });
  const dismiss = page.locator('.ib-toast [data-toast-dismiss]');
  if ((await dismiss.count()) > 0) await dismiss.first().click({ timeout: 2_000 }).catch(() => {});
}
