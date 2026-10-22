/**
 * Fitting the thread foot's button row on one line (review of PR #2091).
 *
 * The "N open questions" button takes the longest label that keeps every
 * button of the row on one line: "6 open questions", then "6 open", then
 * "6" (the question icon and the count). A phone never takes the long form.
 * Before a form gives way to a shorter one, the row tries it tightened: the
 * buttons' side padding and the gaps get smaller and the button drops its
 * chevron (`data-fit-tight`, inbox.css), as a phone with Send, Edit draft and
 * Re-ask needs.
 * And on a phone the "↓ N new" pill, laid over the middle of the row, moves
 * above the foot when a button sits under that middle.
 *
 * The rules are pure; `fitFootRow` tries them against the page's own layout.
 */

/** The button's label, longest first. */
export type OpenQuestionsLabelForm = 'full' | 'short' | 'count';

export const OPEN_QUESTIONS_LABEL_FORMS: readonly OpenQuestionsLabelForm[] = ['full', 'short', 'count'];

/** The visible words of each form: "6 open questions" / "6 open" / "6". */
export function openQuestionsFormText(n: number, form: OpenQuestionsLabelForm): string {
  if (form === 'count') return String(n);
  if (form === 'short') return `${n} open`;
  return `${n} open question${n === 1 ? '' : 's'}`;
}

/** One way to draw the button: a label form, on the row's usual spacing or the tight one. */
export interface FootFit {
  form: OpenQuestionsLabelForm;
  tight: boolean;
}

/**
 * The ways to try, best first: each form no longer than `max`, longest
 * first, on the usual spacing and then on the tight one. Words come before
 * spacing: "5 open" on a slightly tighter row says more than "5" on the usual.
 */
export function footFitCandidates(max: OpenQuestionsLabelForm): FootFit[] {
  const forms = OPEN_QUESTIONS_LABEL_FORMS.slice(OPEN_QUESTIONS_LABEL_FORMS.indexOf(max));
  return forms.flatMap((form) => [
    { form, tight: false },
    { form, tight: true },
  ]);
}

/** All on one line: every box starts within a pixel of the first. */
export function onOneLine(tops: readonly number[]): boolean {
  return tops.every((top) => Math.abs(top - tops[0]!) <= 1);
}

export interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Span, b: Span) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether the pill, centred on the row with `margin` around it, would lie
 * over one of the row's buttons. Direction-agnostic: it compares boxes.
 */
export function pillHitsButtons(row: Span, pill: { width: number; height: number }, buttons: readonly Span[], margin = 8): boolean {
  const cx = (row.left + row.right) / 2;
  const cy = (row.top + row.bottom) / 2;
  const box: Span = {
    left: cx - pill.width / 2 - margin,
    right: cx + pill.width / 2 + margin,
    top: cy - pill.height / 2,
    bottom: cy + pill.height / 2,
  };
  return buttons.some((b) => b.right > b.left && overlaps(box, b));
}

// ── DOM ──

/** The children of a flex row that take part in its layout (not hidden, not taken out of flow). */
export function laidOutChildren(row: Element): HTMLElement[] {
  return [...row.children].filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
  });
}

/**
 * Tries each way in turn on the page itself (before paint: the caller runs in
 * a layout effect) and leaves the button drawn the first way that keeps the
 * row on one line; none does: the last. `apply` draws one way on the button.
 * Null where there is no layout (a test DOM, a hidden pane).
 */
export function fitFootRow(buttons: HTMLElement, candidates: readonly FootFit[], apply: (fit: FootFit) => void): FootFit | null {
  if (buttons.getBoundingClientRect().width <= 0 || candidates.length === 0) return null;
  for (const fit of candidates) {
    apply(fit);
    if (onOneLine(laidOutChildren(buttons).map((el) => el.getBoundingClientRect().top))) return fit;
  }
  return candidates[candidates.length - 1]!;
}
