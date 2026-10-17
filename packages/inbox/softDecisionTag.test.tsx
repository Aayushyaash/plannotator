/**
 * The question card's "Records a decision" tag in the Inbox: switched off it
 * takes the quiet text colour (inbox.css, under the Soft card switch), and
 * switched back on it is the accent again, exactly as a tag that was never
 * off. The failure this catches: the off colour keyed on ui's inline `style`
 * (`[style]`), which React leaves behind as `style=""` once the tag is
 * switched back on, so a tag that had been off once stayed grey while on.
 *
 * ui's real card is rendered; the colour is worked out from inbox.css by
 * cssCascade.testing.ts (happy-dom does not apply the Soft switches).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { BlockRenderer } = (hasDom ? await import('@plannotator/ui/components/BlockRenderer') : {}) as typeof import('@plannotator/ui/components/BlockRenderer');

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
const DOC = `:::question
Where should losing versions be kept?

Decision: when answered

- [ ] Local
- [ ] Server
:::

:::question
Which region?

Decision: when answered

- [ ] EU
- [ ] US
:::
`;

/** The Inbox's card: the tag switches recording and its words open the decision card. */
function Cards() {
  const [off, setOff] = useState<Record<string, boolean>>({});
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  return (
    <div>
      {blocks.map((block) => {
        const question = index.find((q) => q.blockId === block.id);
        return (
          <BlockRenderer
            key={block.id}
            block={block}
            question={question}
            questionTotal={index.length}
            onAnswerQuestion={() => {}}
            questionDecisionRecording={question ? !off[question.question.key] : undefined}
            onToggleQuestionDecisionRecording={(key, next) => setOff((current) => ({ ...current, [key]: !next }))}
            onOpenQuestionDecision={() => {}}
          />
        );
      })}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedClass = hasDom ? document.documentElement.className : '';

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.documentElement.className = savedClass;
});

async function mount(mode: 'light' | 'dark'): Promise<HTMLElement> {
  document.documentElement.className = mode === 'light' ? 'light' : '';
  host = document.createElement('div');
  host.className = 'pn-inbox';
  const body = document.createElement('div');
  body.className = 'ib-body';
  host.append(body);
  document.body.append(host);
  root = createRoot(body);
  await act(async () => root!.render(<Cards />));
  return host;
}

const cards = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('fieldset[data-question-key]')];
const tag = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-question-decision-tag]')!;
const toggle = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[data-question-decision-toggle]')!;

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

describe.if(hasDom)('the "Records a decision" tag in the Inbox', () => {
  for (const mode of ['light', 'dark'] as const) {
    test(`${mode}: off is quiet; back on it is drawn as a tag that was never off`, async () => {
      const el = await mount(mode);
      const [first, second] = cards(el);
      expect(tag(first!) !== null && tag(second!) !== null).toBe(true);
      const neverOff = loadCascade(CSS).resolved(tag(second!), 'color');
      expect(neverOff).toBeDefined();

      await click(toggle(first!));
      expect(cards(el)[0]!.dataset.questionDecisionRecording).toBe('off');
      const off = loadCascade(CSS).resolved(tag(cards(el)[0]!), 'color');
      expect(off).not.toBe(neverOff);

      await click(toggle(cards(el)[0]!));
      const card = cards(el)[0]!;
      expect(card.dataset.questionDecisionRecording).toBe('on');
      expect(toggle(card).getAttribute('aria-pressed')).toBe('true');
      // React clears the inline style property by property; a browser keeps the emptied attribute (`style=""`),
      // happy-dom drops it. Put back what a browser leaves.
      if (!tag(card).hasAttribute('style')) tag(card).setAttribute('style', '');
      expect(loadCascade(CSS).resolved(tag(card), 'color')).toBe(neverOff);
    });
  }
});
