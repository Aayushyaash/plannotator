import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadDiffFont } from './diffFonts';

/**
 * Only the menu's own web fonts may add a stylesheet. A custom name (#851) is
 * free text, so a name that matches something inherited from Object.prototype
 * (`constructor`, `__proto__`, `toString`) must never produce a link.
 *
 * appendChild is intercepted so no stylesheet is ever really inserted (the
 * test environment must not fetch a web font).
 */

const hasDom = typeof document !== 'undefined';
let appended: HTMLLinkElement[] = [];
let originalAppend: typeof document.head.appendChild | null = null;

beforeEach(() => {
  if (!hasDom) return;
  appended = [];
  originalAppend = document.head.appendChild;
  document.head.appendChild = (<T extends Node>(node: T): T => {
    appended.push(node as unknown as HTMLLinkElement);
    return node;
  }) as typeof document.head.appendChild;
});

afterEach(() => {
  if (hasDom && originalAppend) document.head.appendChild = originalAppend;
});

describe.if(hasDom)('loadDiffFont', () => {
  test('inherited names and installed fonts add no stylesheet', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'Iosevka Term']) {
      loadDiffFont(name);
    }
    expect(appended).toHaveLength(0);
  });

  test('a menu web font adds its stylesheet once', () => {
    loadDiffFont('Hack');
    loadDiffFont('Hack');
    expect(appended).toHaveLength(1);
    expect(appended[0].rel).toBe('stylesheet');
    expect(appended[0].dataset.diffFont).toBe('Hack');
  });
});
