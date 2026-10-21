import { describe, expect, test } from 'bun:test';
import { buildPierreFontCSS } from './pierreFontCss';

describe('buildPierreFontCSS', () => {
  test('nothing set, nothing injected', () => {
    expect(buildPierreFontCSS(undefined, undefined)).toBe('');
    expect(buildPierreFontCSS('', '')).toBe('');
  });

  test('a custom installed font is quoted and falls back to monospace', () => {
    const css = buildPierreFontCSS('Iosevka Term', undefined);
    expect(css).toContain('font-family: "Iosevka Term", monospace !important;');
    expect(css).not.toContain('font-size');
  });

  test('a name with quotes or a line break cannot add declarations', () => {
    const css = buildPierreFontCSS('x"; } :host { display: none; } a { b: "\nc', '14px');
    const line = css.split('\n').find((l) => l.includes('font-family'))!;
    // With every escape pair (\\x) removed, the value is exactly one string
    // followed by the generic: the injected quotes and braces stayed inside it.
    const value = line.trim().replace(/^font-family: /, '').replace(/\\./g, '');
    expect(value).toMatch(/^"[^"\n]*", monospace !important;$/);
    expect(css).toContain('font-size: 14px !important;');
  });
});
