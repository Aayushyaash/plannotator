/**
 * The What's new page's header as drawn (approval
 * .product/approved/inbox-whats-new-header/, variant Toolbar): the bar's way
 * back and its actions, the one standing chip in its states (current,
 * behind, development build), Update only when the page's release can be
 * installed, and the chip's jump to the skipped releases.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxUpdate } from '@plannotator/core/inbox-types';
import type { WhatsNewModel } from './api';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws the notes with ui's Viewer, which reads `window` at module-eval time.
const { WhatsNewPage, whatsNewStanding, whatsNewCanUpdate } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const model = (over: Partial<WhatsNewModel> = {}): WhatsNewModel => ({
  version: '0.28.22',
  current: '0.28.19',
  since: '0.28.19',
  published_at: '2026-10-15T12:00:00Z',
  release_url: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.22',
  notes: 'Mostly Inbox work.',
  skipped: [
    { version: '0.28.21', text: 'Twenty-one' },
    { version: '0.28.20', text: 'Twenty' },
  ],
  ...over,
});

const update = (state: InboxUpdate['state'], version = '0.28.22'): InboxUpdate => ({
  available: true,
  state,
  version,
  current: '0.28.19',
  action: 'script',
  releaseUrl: `https://github.com/backnotprop/plannotator/releases/tag/v${version}`,
});

function render(props: { model: WhatsNewModel | null; update?: InboxUpdate | null; onBack?: () => void; onUpdate?: () => void }) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <WhatsNewPage
          model={props.model}
          error={null}
          update={props.update ?? null}
          onBack={props.onBack ?? (() => {})}
          onUpdate={props.onUpdate ?? (() => {})}
        />
      </SidebarProvider>,
    );
  });
  return host;
}

const chip = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-whats-new-standing]');

test.skipIf(!hasDom)('the standing: current, behind with the releases in between, a development build, past it', () => {
  expect(whatsNewStanding(model({ current: '0.28.22' }))).toEqual({ kind: 'current' });
  expect(whatsNewStanding(model())).toEqual({ kind: 'behind', current: '0.28.19', between: 2 });
  // A development build is never "You have dev", whatever the release.
  expect(whatsNewStanding(model({ current: 'dev' }))).toEqual({ kind: 'dev' });
  expect(whatsNewStanding(model({ current: '0.0.0-dev' }))).toEqual({ kind: 'dev' });
  expect(whatsNewStanding(model({ current: '0.28.23' }))).toEqual({ kind: 'ahead', current: '0.28.23' });
});

test.skipIf(!hasDom)('on the version: one quiet chip, no Update, no jump', () => {
  const el = render({ model: model({ current: '0.28.22', since: '0.28.19' }), update: null });
  expect(chip(el)?.dataset.whatsNewStanding).toBe('current');
  expect(chip(el)?.tagName).toBe('SPAN');
  expect(el.querySelector('[data-whats-new-update]')).toBeNull();
  // The releases skipped before the update are still listed, counted from the version run before it.
  expect(el.querySelector('[data-skipped-releases] h2')?.textContent).toContain('0.28.19');
  expect(el.querySelectorAll('[data-skipped-releases] li')).toHaveLength(2);
});

test.skipIf(!hasDom)('a development build says so and never names "dev" as a version', () => {
  const el = render({ model: model({ current: 'dev', since: null, skipped: [] }) });
  expect(chip(el)?.dataset.whatsNewStanding).toBe('dev');
  expect(el.querySelector('.ib-wn-hero')?.textContent).not.toContain('You have dev');
});

test.skipIf(!hasDom)('behind: the chip names the version and the releases in between, and jumps to them', () => {
  const el = render({ model: model() });
  const button = chip(el) as HTMLButtonElement;
  expect(button.tagName).toBe('BUTTON');
  expect(button.textContent).toContain('0.28.19');
  expect(button.textContent).toContain('2 releases');
  const section = el.querySelector<HTMLElement>('[data-skipped-releases]')!;
  expect(button.getAttribute('aria-controls')).toBe(section.id);
  let scrolled = false;
  section.scrollIntoView = () => {
    scrolled = true;
  };
  act(() => button.click());
  expect(scrolled).toBe(true);
  expect(document.activeElement).toBe(section);
});

test.skipIf(!hasDom)('behind with more than a few skipped: the jump opens the folded list', () => {
  const skipped = ['0.28.21', '0.28.20', '0.28.19', '0.28.18'].map((version) => ({ version, text: version }));
  const el = render({ model: model({ current: '0.28.17', since: '0.28.17', skipped }) });
  const details = el.querySelector('details[data-skipped-releases]') as HTMLDetailsElement;
  details.scrollIntoView = () => {};
  expect(details.open).toBe(false);
  act(() => (chip(el) as HTMLButtonElement).click());
  expect(details.open).toBe(true);
  expect(chip(el)?.textContent).toContain('4 releases');
});

test.skipIf(!hasDom)('behind with nothing listed in between: the version alone, with nowhere to jump', () => {
  const el = render({ model: model({ current: '0.28.21', since: '0.28.21', skipped: [] }) });
  expect(chip(el)?.tagName).toBe('SPAN');
  expect(chip(el)?.textContent).toContain('0.28.21');
});

test.skipIf(!hasDom)('Update shows only when this release can be installed today, and does what the header Update did', () => {
  expect(whatsNewCanUpdate(model(), update('available'))).toBe(true);
  expect(whatsNewCanUpdate(model(), update('ready'))).toBe(true);
  expect(whatsNewCanUpdate(model(), update('updating'))).toBe(false);
  expect(whatsNewCanUpdate(model(), update('failed'))).toBe(false);
  expect(whatsNewCanUpdate(model(), update('available', '0.28.23'))).toBe(false);
  expect(whatsNewCanUpdate(model(), null)).toBe(false);

  let pressed = 0;
  const el = render({ model: model(), update: update('available'), onUpdate: () => pressed++ });
  const button = el.querySelector<HTMLButtonElement>('[data-whats-new-update]')!;
  // A deliberate action label: the button names the version it installs ("to 0.28.22" may drop visually on a narrow phone).
  expect(button.getAttribute('aria-label')).toBe('Update to 0.28.22');
  expect(button.querySelector('.ib-wn-to')?.textContent).toBe('to 0.28.22');
  act(() => button.click());
  expect(pressed).toBe(1);
  // Behind with update checks off: no Update in the bar.
  act(() => root!.unmount());
  host!.remove();
  const off = render({ model: model(), update: null });
  expect(off.querySelector('[data-whats-new-update]')).toBeNull();
});

test.skipIf(!hasDom)('the bar: the way back on the left, the release on GitHub in a new tab, the old header gone', () => {
  let back = 0;
  const el = render({ model: model(), onBack: () => back++ });
  const bar = el.querySelector('.ib-wn-bar')!;
  const backButton = bar.querySelector<HTMLButtonElement>('[data-whats-new-back]')!;
  expect(backButton.compareDocumentPosition(bar.querySelector('.ib-wn-acts')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => backButton.click());
  expect(back).toBe(1);
  const github = bar.querySelector<HTMLAnchorElement>('[data-whats-new-github]')!;
  expect(github.href).toBe(model().release_url);
  expect(github.target).toBe('_blank');
  expect(github.rel).toContain('noopener');
  // The sidebar toggle stays on the page.
  expect(bar.querySelector('[data-sidebar="trigger"]')).not.toBeNull();
  // One way back only: the old right-side "← Inbox" and the old meta line are gone.
  expect(el.querySelectorAll('[data-whats-new-back]')).toHaveLength(1);
  expect(el.querySelector('.ib-wn-head')).toBeNull();
  expect(el.querySelector('.ib-wn-hero h1')?.textContent).toBe('0.28.22');
});
