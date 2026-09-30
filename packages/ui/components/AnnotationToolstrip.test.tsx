import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorMode, InputMethod } from '../types';
import { AnnotationToolstrip } from './AnnotationToolstrip';

const hasDom = typeof document !== 'undefined';
const remainingLabels = ['Select', 'Pinpoint', 'Markup', 'Comment', 'Redline'] as const;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function buttonFor(label: string): HTMLButtonElement | null {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) =>
    button.querySelector<HTMLSpanElement>('span:not([aria-hidden])')?.textContent === label,
  ) ?? null;
}

function ControlledToolstrip({ hideQuickLabel = false }: { hideQuickLabel?: boolean }) {
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');

  return (
    <AnnotationToolstrip
      inputMethod={inputMethod}
      onInputMethodChange={setInputMethod}
      mode={mode}
      onModeChange={setMode}
      hideQuickLabel={hideQuickLabel}
    />
  );
}

async function mount(hideQuickLabel?: boolean): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root?.render(<ControlledToolstrip hideQuickLabel={hideQuickLabel} />);
  });
}

async function press(label: string): Promise<void> {
  const button = buttonFor(label);
  if (!button) throw new Error(`Expected ${label} button to render`);
  await act(async () => button.click());
  expect(buttonFor(label)?.getAttribute('aria-pressed')).toBe('true');
}

describe.if(hasDom)('AnnotationToolstrip Quick Label seam', () => {
  test('includes Label by default', async () => {
    await mount();

    expect(buttonFor('Label')).not.toBeNull();
    for (const label of remainingLabels) expect(buttonFor(label)).not.toBeNull();
  });

  test('omits only Label while every remaining control stays operative', async () => {
    await mount(true);

    expect(buttonFor('Label')).toBeNull();
    for (const label of remainingLabels) expect(buttonFor(label)).not.toBeNull();

    await press('Pinpoint');
    expect(buttonFor('Select')?.getAttribute('aria-pressed')).toBe('false');
    await press('Select');
    expect(buttonFor('Pinpoint')?.getAttribute('aria-pressed')).toBe('false');

    await press('Comment');
    expect(buttonFor('Markup')?.getAttribute('aria-pressed')).toBe('false');
    await press('Redline');
    expect(buttonFor('Comment')?.getAttribute('aria-pressed')).toBe('false');
    await press('Markup');
    expect(buttonFor('Redline')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('helpOnly renders only the help button without tool buttons', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <AnnotationToolstrip
          inputMethod="drag"
          onInputMethodChange={() => {}}
          mode="selection"
          onModeChange={() => {}}
          helpOnly
          showHelpLink
        />
      );
    });

    for (const label of remainingLabels) expect(buttonFor(label)).toBeNull();
    expect(buttonFor('Label')).toBeNull();
    const helpButton = host?.querySelector('button');
    expect(helpButton?.textContent?.trim()).toBe('how does this work?');
  });

  test('hoveredButton synchronizes compact button expansion', async () => {
    let hovered: string | null = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <AnnotationToolstrip
          inputMethod="drag"
          onInputMethodChange={() => {}}
          mode="selection"
          onModeChange={() => {}}
          compact
          hoveredButton="Redline"
          onHoverButton={(btn) => { hovered = btn; }}
        />
      );
    });

    const redline = buttonFor('Redline');
    const comment = buttonFor('Comment');
    if (!redline || !comment) throw new Error('Expected buttons to render');

    // In compact mode, unselected unhovered comment stays collapsed at 28px
    expect(comment.style.width).toBe('28px');
    // Hovered Redline expands beyond 28px
    expect(parseFloat(redline.style.width)).toBeGreaterThan(28);

    // Mouse enter on comment triggers onHoverButton('Comment')
    await act(async () => {
      comment.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(hovered).toBe('Comment');

    // Mouse out triggers onHoverButton(null)
    await act(async () => {
      comment.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(hovered).toBeNull();
  });
});
