/**
 * The Soft look's one type knob, --ib-soft-type (inbox.css, owner 2026-10-17:
 * "tone down the font just one bit down ... base font down"). Every size the
 * window sets goes through one scale token, `var(--ib-fs-N, Npx)` with
 * `--ib-fs-N: max(12px, calc(Npx * var(--ib-type)))`, so the switch moves the
 * whole window together and, off, each size is exactly today's.
 *
 * What this catches: a rule added with a bare `font-size: 13px` (it would not
 * follow the knob), a token whose number differs from its fallback (off would
 * no longer be today's), a scale token missing or without the 12 px floor, the
 * switch left on by default, and a phone input scaled under 16 px (iOS zooms).
 * The same file holds the layout corners' one scale and the rows' switch,
 * checked at the end.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
/** inbox.css with its comments blanked, offsets kept. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

/** For each offset, whether it sits inside an @media block. */
function mediaMask(code: string): boolean[] {
  const mask: boolean[] = new Array(code.length).fill(false);
  const stack: boolean[] = [];
  let headerStart = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') {
      stack.push(code.slice(headerStart, i).trim().startsWith('@media'));
      headerStart = i + 1;
    } else if (ch === '}') {
      stack.pop();
      headerStart = i + 1;
    } else if (ch === ';') headerStart = i + 1;
    mask[i] = stack.includes(true);
  }
  return mask;
}

test('the type switch is off by default: today\'s sizes', () => {
  expect(CODE).toMatch(/--ib-soft-type:\s*initial;/);
  expect(CODE).not.toMatch(/--ib-soft-type:\s*;/);
  // The base in px, so each size is N px * base / 14: exact (14 px is 13 px on, N px off).
  expect(CODE).toMatch(/--ib-type-s:\s*var\(--ib-soft-type\)\s*13;/);
  expect(CODE).toMatch(/--ib-type:\s*var\(--ib-type-s,\s*14\);/);
});

test('every size of 12.5 px or more goes through its scale token, and the fallback is the same size', () => {
  const mask = mediaMask(CODE);
  const bare: string[] = [];
  for (const m of CODE.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px(\s*!important)?/g)) {
    const n = Number(m[1]);
    if (n < 12.5 || m[2]) continue;
    // A phone's 16 px stays 16 (iOS zooms into a smaller input); inside @media only.
    if (n === 16 && mask[m.index!]) continue;
    bare.push(`${m[0]} at ${CODE.slice(0, m.index).split('\n').length}`);
  }
  expect(bare).toEqual([]);
  const uses = [...CODE.matchAll(/font-size:\s*var\(--ib-fs-([\d-]+),\s*([\d.]+)px\)/g)];
  expect(uses.length).toBeGreaterThan(300);
  for (const use of uses) expect(use[1]!.replace('-', '.')).toBe(use[2]);
});

test('each scale token floors at 12 px and scales its own size', () => {
  const used = new Set([...CODE.matchAll(/var\(--ib-fs-([\d-]+),/g)].map((m) => m[1]!));
  for (const name of used) {
    const size = name.replace('-', '.');
    const def = new RegExp(`--ib-fs-${name}:\\s*max\\(12px,\\s*calc\\(${size.replace('.', '\\.')}px \\* var\\(--ib-type\\) / 14\\)\\);`);
    expect(CODE).toMatch(def);
  }
});

test("ui's drawing follows the knob: Tailwind's type scale and its fixed sizes, in a layer after the utilities", () => {
  for (const [name, rem] of [['sm', '0.875'], ['base', '1'], ['lg', '1.0625'], ['xl', '1.1875'], ['2xl', '1.375']] as const) {
    expect(CODE).toMatch(new RegExp(`--text-${name}:\\s*calc\\(${rem.replace('.', '\\.')}rem \\* var\\(--ib-type\\) / 14\\);`));
  }
  // Code blocks (Plannotator's fence, copied here) follow it too.
  expect(CODE).toMatch(/pre code\.pn-code \{[^}]*font-size: var\(--ib-fs-13, 0\.8125rem\);/);
  const layer = /@layer ib-type \{([\s\S]*?)\n\}/.exec(CODE)?.[1] ?? '';
  for (const size of ['12.5', '13', '13.5', '14', '15']) {
    const cls = size.replace('.', '\\\\.');
    expect(layer).toMatch(new RegExp(`\\.pn-inbox \\.text-\\\\\\[${cls}px\\\\\\] \\{ font-size: var\\(--ib-fs-${size.replace('.', '-')}, ${size.replace('.', '\\.')}px\\); \\}`));
  }
});

test('layout corners are one scale; buttons keep their own', () => {
  for (const [token, px] of [['pane', 10], ['xl', 12], ['lg', 10], ['md', 9], ['sm', 8], ['xs', 7]] as const) {
    expect(CODE).toMatch(new RegExp(`--ib-lr-${token}:\\s*${px}px;`));
  }
  expect(CODE).toMatch(/--ib-pane-r-s:\s*var\(--ib-soft-panes\)\s*var\(--ib-lr-pane\);/);
  // The list's row pills, a section band, a tile and a dialog read the scale.
  expect(CODE).toMatch(/:is\(\.ib-row, \.ib-nrow\)::before \{ border-radius: var\(--ib-rl-sm-s, 8px\); \}/);
  expect(CODE).toMatch(/--ib-band-r-s:\s*var\(--ib-soft-band\)\s*var\(--ib-lr-sm\);/);
  expect(CODE).toMatch(/--ib-sf-r14-s:\s*var\(--ib-soft-surfaces\)\s*var\(--ib-lr-lg\);/);
  expect(CODE).toMatch(/dialog\.ib-dlg \{[^}]*border-radius: var\(--ib-rl-xl-s, 12px\)/);
  // The header's buttons, the foot's pills and the window's buttons keep theirs.
  expect(CODE).toMatch(/\.pn-inbox \.ib-hbtn \{[^}]*border-radius: var\(--ib-r10-s, 7px\)/);
  expect(CODE).toMatch(/--ib-ft-r-s:\s*var\(--ib-soft-foot\)\s*999px;/);
  expect(CODE).toMatch(/--ib-bt-r-s:\s*var\(--ib-soft-buttons\)\s*10px;/);
});

test('rows part with no line between them in both modes (the prototype\'s rows); other lines keep today\'s colour', () => {
  expect(CODE).toMatch(/\.pn-inbox \{[^}]*--ib-soft-rows:\s*;/);
  const light = /:root\.light \.pn-inbox \{([^}]*)\}/.exec(CODE)?.[1] ?? '';
  expect(light).not.toContain('--ib-soft-rows');
  expect(CODE).toMatch(/--ib-row-line-s:\s*var\(--ib-soft-rows\)\s*transparent;/);
  expect(CODE).toMatch(/\.ib-row, \.ib-nrow \{ border-bottom-color: var\(--ib-row-line\); \}/);
  // Every other line keeps today's colour: its faint fill has a switch of its own, off.
  expect(CODE).toMatch(/--ib-soft-lines:\s*initial;/);
  expect(CODE).toMatch(/--ib-sep-s:\s*var\(--ib-soft-lines\)\s*var\(--ib-fill\);/);
  expect(CODE).not.toMatch(/var\(--ib-soft-rows\)\s*var\(--ib-fill\)/);
});
