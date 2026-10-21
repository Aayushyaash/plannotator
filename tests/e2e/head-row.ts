/**
 * A message's head row (design record "inbox-polish", item 5): what is drawn
 * in it must be drawn whole. Node-safe; the specs import it.
 */
import type { Locator } from '@playwright/test';

/**
 * Why `part` is not drawn whole inside its head row, or null when it is: it
 * has no box, it runs past the row, past an ancestor that clips (up to the
 * thread pane), or into the row's time column.
 */
export function cutInHeadRow(part: Locator): Promise<string | null> {
  return part.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'not drawn';
    const row = el.closest('.ib-fline');
    if (!row) return 'not in a head row';
    const inside = (b: DOMRect) => r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
    if (!inside(row.getBoundingClientRect())) return 'runs past its row';
    for (let a = el.parentElement; a && !a.matches('section.ib-pane'); a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      if (!inside(a.getBoundingClientRect())) return `cut by .${[...a.classList].join('.')}`;
    }
    const time = row.querySelector(':scope > .ib-fl-tm');
    if (time && !el.closest('.ib-fl-tm')) {
      const t = time.getBoundingClientRect();
      const x = Math.min(r.right, t.right) - Math.max(r.left, t.left);
      const y = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
      if (x > 0.5 && y > 0.5) return 'under the time';
    }
    return null;
  });
}
