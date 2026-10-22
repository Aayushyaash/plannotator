/**
 * An attached markdown file is always drawn in the Clean look: the document on
 * the card colour, never plan review's grid paper, whatever plan review's
 * `gridEnabled` setting says (owner, 2026-10-22).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const GRID_COOKIE = 'plannotator-grid-enabled';

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) document.cookie = `${GRID_COOKIE}=; path=/; max-age=0`;
});

const PLAN = '# Retry worker\n\nRetry the failed webhooks one by one.\n';
const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/retry-plan.md',
  named_path: null,
  name: 'retry-plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: PLAN.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: PLAN.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

test.skipIf(!hasDom)('an attached markdown file renders Clean even with Grid chosen in plan review', async () => {
  // The cookie plan review's Settings writes for "Grid".
  document.cookie = `${GRID_COOKIE}=true; path=/`;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment, version: 'current', text: PLAN, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={false}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('.ib-docscroll article')?.textContent?.includes('Retry worker'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  const scroll = host!.querySelector('.ib-docscroll');
  expect(scroll).not.toBeNull();
  expect(scroll!.getAttribute('data-look')).toBe('clean');
  expect(scroll!.classList.contains('bg-card')).toBe(true);
  expect(scroll!.classList.contains('bg-grid')).toBe(false);
  // Viewer's Clean article: no grid card (shadow and border) around the document.
  const article = scroll!.querySelector('article');
  expect(article?.textContent).toContain('Retry worker');
  expect(article!.classList.contains('shadow-xl')).toBe(false);
});
