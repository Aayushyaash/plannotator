/** Annotate file switches use real files; only AI transport is intercepted. */
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');

test('Ask AI keeps the conversation and the document it was asked about', async ({ page }) => {
  page.setDefaultTimeout(15_000);
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-annotate-ai-e2e-');
  const docs = join(root, 'docs');
  mkdirSync(docs);
  const alpha = '# Alpha\n\nAlpha content.\n';
  const beta = '# Beta\n\nBeta content.\n';
  writeFileSync(join(docs, 'alpha.md'), alpha);
  writeFileSync(join(docs, 'beta.md'), beta);
  const ready = join(root, 'ready.jsonl');
  const child = spawn(binary, ['annotate', docs], {
    cwd: root,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '', HOME: root,
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
    },
  });
  let url: string | undefined;
  try {
    await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '').toContain('"url"');
    url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url;
    await page.context().addCookies([
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
    ].map(([name, value]) => ({ name: name!, value: value!, url: url! })));
    let sessions = 0;
    const queries: Array<{ sessionId: string; prompt: string; draftAnnotations?: string }> = [];
    await page.route('**/api/ai/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/capabilities')) {
        await route.fulfill({ json: { available: true, defaultProvider: 'test', providers: [{ id: 'test', name: 'session-bridge', capabilities: {}, models: [{ id: 'one', label: 'One' }] }] } });
      } else if (path.endsWith('/session')) {
        sessions += 1;
        await route.fulfill({ json: { sessionId: `s-${sessions}` } });
      } else if (path.endsWith('/query')) {
        queries.push(route.request().postDataJSON());
        const text = `Answer ${queries.length}`;
        const event = queries.length === 1
          ? { type: 'error', error: 'The session is busy.', code: 'agent_busy' }
          : { type: 'text_delta', delta: text };
        const tail = queries.length === 1
          ? 'data: [DONE]\n\n'
          : `data: ${JSON.stringify({ type: 'result', result: text })}\n\n`;
        await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\n${tail}` });
      } else {
        await route.fulfill({ json: {} });
      }
    });
    await page.goto(url!);
    await page.getByRole('button', { name: 'alpha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Global comment', exact: true }).click();
    const composer = page.locator('[data-comment-popover]');
    await composer.getByPlaceholder('Add a global comment...').fill('Keep this draft separate');
    await composer.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Show AI chat', exact: true }).click();
    await page.getByPlaceholder('Ask about this document...').fill('Question on alpha');
    await page.getByRole('button', { name: 'Send AI question' }).click();
    await expect(page.getByRole('button', { name: 'Ask when it finishes' })).toBeVisible();
    await page.getByRole('button', { name: 'beta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
    if (await page.getByRole('button', { name: 'Show AI chat', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Show AI chat', exact: true }).click();
    }
    await expect(page.getByText('Question on alpha', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ask when it finishes' }).click();
    await expect(page.getByText('Answer 2', { exact: true })).toBeVisible();
    expect(queries[1]!.prompt).toBe(queries[0]!.prompt);
    expect(queries[1]!.prompt).toContain(JSON.stringify(alpha));
    expect(queries[1]!.prompt).not.toContain('Keep this draft separate');
    expect(queries[0]!.draftAnnotations).toContain('Keep this draft separate');
    expect(queries[1]!.sessionId).toBe('s-1');
    await page.getByPlaceholder('Ask about this document...').fill('Question on beta');
    await page.getByRole('button', { name: 'Send AI question' }).click();
    await expect(page.getByText('Answer 3', { exact: true })).toBeVisible();
    expect(queries[2]!.sessionId).toBe('s-1');
    expect(queries[2]!.prompt).toContain('Beta content');
    expect(queries[2]!.prompt).not.toContain('Alpha content');
    expect(sessions).toBe(1);
    await expect(page.getByText('Question on alpha', { exact: true })).toHaveCount(1);
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      // inbox-guard: own child (only the annotate CLI spawned by this test).
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      child.kill('SIGTERM');
      await exited;
    }
    await removeInboxScratch(root);
  }
});
