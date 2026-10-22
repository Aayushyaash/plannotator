import type { Hunk } from '@pierre/diffs';
import { getSearchRoots } from './reviewSearchHighlight';

/**
 * Jumping to the next / previous change (`N` / `Shift+N`, #1543).
 *
 * A "change" is one run of consecutive `-` / `+` lines (Pierre's
 * `ChangeContent`), not a whole `@@` hunk: one hunk can hold several changes
 * separated by a few context lines, and with full file context shown they are
 * what the reviewer scrolls between.
 */

export type ChangeSide = 'additions' | 'deletions';

export interface DiffChange {
  /** Unified row index of the change's first line (Pierre's `data-line-index` "u,s"). */
  unifiedIndex: number;
  /** Line number of the first line, on `side` (old file for deletions). */
  lineNumber: number;
  side: ChangeSide;
}

export type ChangeHunk = Pick<Hunk, 'additionStart' | 'deletionStart' | 'unifiedLineStart' | 'hunkContent'>;

/** Every change of a file diff, in file order. */
export function listDiffChanges(hunks: readonly ChangeHunk[] | null | undefined): DiffChange[] {
  const changes: DiffChange[] = [];
  for (const hunk of hunks ?? []) {
    let unified = hunk.unifiedLineStart;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent ?? []) {
      if (content.type === 'context') {
        unified += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      if (content.deletions + content.additions === 0) continue;
      changes.push(
        content.deletions > 0
          ? { unifiedIndex: unified, lineNumber: oldLine, side: 'deletions' }
          : { unifiedIndex: unified, lineNumber: newLine, side: 'additions' },
      );
      unified += content.deletions + content.additions;
      oldLine += content.deletions;
      newLine += content.additions;
    }
  }
  return changes;
}

/** Where a change sits relative to the reading line (the middle of the view). */
export type ChangePlacement = 'before' | 'at' | 'after';

/**
 * Which change a jump lands on. `current` is the change the last jump landed
 * on while it is still on screen: stepping from it never depends on where the
 * scroll could put it (the last change of a file cannot always reach the
 * middle). Without it, the next change is the first one past the reading line
 * and the previous one the last before it. Null at either end.
 */
export function resolveChangeJump(
  placements: readonly ChangePlacement[],
  direction: 'next' | 'prev',
  current: number | null,
): number | null {
  if (placements.length === 0) return null;
  if (current != null && current >= 0 && current < placements.length) {
    const target = direction === 'next' ? current + 1 : current - 1;
    return target >= 0 && target < placements.length ? target : null;
  }
  if (direction === 'next') {
    const index = placements.indexOf('after');
    return index === -1 ? null : index;
  }
  const index = placements.lastIndexOf('before');
  return index === -1 ? null : index;
}

/**
 * The line a jump is measured from. Normally the middle of the view, which
 * the jump centres a change on. At the top of the scroll it is the top of the
 * view for `N`, so the first press lands on the first change below the
 * current position instead of skipping the ones already on screen; at the
 * bottom it is the bottom of the view for `Shift+N`, likewise.
 */
export function readingLineFor(
  view: { top: number; bottom: number },
  direction: 'next' | 'prev',
  scroll: { atTop: boolean; atBottom: boolean },
): number {
  if (direction === 'next' && scroll.atTop) return view.top - 1;
  if (direction === 'prev' && scroll.atBottom) return view.bottom + 1;
  return (view.top + view.bottom) / 2;
}

export function placementOf(
  rect: { top: number; height: number },
  readingLine: number,
): ChangePlacement {
  const middle = rect.top + rect.height / 2;
  const slack = Math.max(4, rect.height / 2);
  if (middle < readingLine - slack) return 'before';
  if (middle > readingLine + slack) return 'after';
  return 'at';
}

/** The rendered first line of a change, inside `root` (shadow roots included). */
export function findChangeElement(root: ParentNode, change: DiffChange): HTMLElement | null {
  const selector = `[data-line-type^="change-"][data-line-index^="${change.unifiedIndex},"]`;
  for (const searchRoot of getSearchRoots(root)) {
    const el = searchRoot.querySelector?.(selector);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

/** The unified rows Pierre has rendered inside `root`, or null when none. */
export function renderedUnifiedRange(root: ParentNode): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const searchRoot of getSearchRoots(root)) {
    for (const el of searchRoot.querySelectorAll?.('[data-line-index]') ?? []) {
      const unified = Number.parseInt(el.getAttribute('data-line-index') ?? '', 10);
      if (!Number.isFinite(unified)) continue;
      if (unified < min) min = unified;
      if (unified > max) max = unified;
    }
  }
  return min === Infinity ? null : { min, max };
}

/**
 * The jump direction a key asks for: `N` next, `Shift+N` previous (the
 * `nextChange` / `prevChange` bindings in review-editor/shortcuts.ts). Never
 * with Mod or Alt, while typing, while an IME composes, or once another
 * handler took the key.
 */
export function changeJumpDirection(event: KeyboardEvent): 'next' | 'prev' | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key !== 'n' && event.key !== 'N') return null;
  if (isTypingOrigin(event)) return null;
  return event.shiftKey ? 'prev' : 'next';
}

/**
 * True when the key comes from somewhere the person types. Reads
 * composedPath()[0]: at window level `event.target` is retargeted to a shadow
 * host, which would hide the Pierre editor's contenteditable.
 */
export function isTypingOrigin(event: KeyboardEvent): boolean {
  const origin = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!origin || typeof origin !== 'object') return false;
  const tag = origin.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || origin.isContentEditable === true;
}
