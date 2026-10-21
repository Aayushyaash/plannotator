/**
 * The box the compose picker hangs off (caretMenu.ts caretAnchor): the
 * caret's line, held inside the part of the field that is on screen, so a
 * field scrolled past the caret keeps the picker beside the field instead of
 * floating over the To line or the footer.
 */
import { describe, expect, test } from 'bun:test';
import { caretAnchor } from './caretMenu';

const field = { left: 40, width: 600 };

describe('caretAnchor', () => {
  test('the caret line as it is when it is in view, across the field', () => {
    expect(caretAnchor({ top: 300, bottom: 324 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 300, bottom: 324, left: 40, width: 600 });
  });

  test('a line scrolled above the visible field pins to its top edge', () => {
    expect(caretAnchor({ top: 120, bottom: 144 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 250, bottom: 274, left: 40, width: 600 });
  });

  test('a line scrolled below the visible field pins to its bottom edge', () => {
    expect(caretAnchor({ top: 700, bottom: 724 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 546, bottom: 570, left: 40, width: 600 });
  });

  test('a visible area shorter than a line never yields a box past it', () => {
    const box = caretAnchor({ top: 300, bottom: 324 }, { top: 250, bottom: 260 }, field);
    expect(box.top).toBe(250);
    expect(box.bottom).toBe(260);
  });
});
