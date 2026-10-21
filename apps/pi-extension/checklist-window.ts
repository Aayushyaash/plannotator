/**
 * The execution checklist widget's window (#1412). Pi draws at most 10 lines
 * of a widget (`InteractiveMode.MAX_WIDGET_LINES`) and cuts the rest with
 * "... (widget truncated)", so past item 10 the widget used to stop showing
 * what the agent works on. The widget now shows 10 items that keep the next
 * open item in view: the first 10 until that item is past them, then a window
 * that ends on it, moving down one item as steps complete, and the last 10
 * once everything is done.
 *
 * UI only: the result feeds `ctx.ui.setWidget`, never a message or a prompt.
 */

/** Pi's widget line cap. */
export const PI_WIDGET_MAX_LINES = 10;

export function checklistWindow<T extends { completed: boolean }>(
	items: readonly T[],
	maxLines: number = PI_WIDGET_MAX_LINES,
): T[] {
	if (items.length <= maxLines) return [...items];
	const next = items.findIndex((item) => !item.completed);
	const end = next === -1 ? items.length : Math.max(maxLines, next + 1);
	return items.slice(end - maxLines, end);
}
