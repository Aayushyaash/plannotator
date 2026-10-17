import React from 'react';
import { Tooltip } from './Tooltip';
import { isTextCut, noHover } from '../utils/textCut';

/**
 * Hover text for a ui control or label, drawn the way the host chooses.
 *
 * Default (every host that does not opt in, Plannotator's plan review,
 * annotate and code review included): the child gets a native `title`,
 * exactly as before.
 *
 * With `configurePlannotatorUI({ componentTooltips: true })` (the Plannotator
 * Inbox): the child gets ui's `Tooltip` instead, and no native title. `name`
 * marks a title that is also the control's accessible name (an icon button
 * with no `aria-label`): the child then gets it as its `aria-label`, so the
 * name never depends on the tooltip. `cut` opens the tooltip only while the
 * child's text is cut. Escape closes it and still reaches the page, and
 * nothing opens on a touch screen.
 */

let componentTooltips = false;

/** Draw ui's hover text as ui's Tooltip (true) or a native title (false, the default). */
export function setComponentTooltips(on: boolean): void {
  componentTooltips = on;
}

export function resetComponentTooltips(): void {
  componentTooltips = false;
}

export function getComponentTooltips(): boolean {
  return componentTooltips;
}

/** How long the pointer rests before a component tooltip opens. */
const HOST_TITLE_DELAY_MS = 150;

/**
 * Where a tooltip for `trigger` is portaled: the open native `<dialog>` it
 * sits in (a popup in the body is drawn under the dialog's top layer), else
 * the nearest host root marked `data-pn-tooltip-root` (its styles and theme
 * tokens then reach the popup), else the body.
 */
export function tooltipContainerOf(trigger: Element): HTMLElement | null {
  return trigger.closest<HTMLElement>('dialog[open], [data-pn-tooltip-root]');
}

export function HostTitle({
  title,
  children,
  name = false,
  cut = false,
  side = 'top',
}: {
  title: string | undefined | null;
  children: React.ReactElement;
  name?: boolean;
  cut?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const descriptionId = React.useId();
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  if (title === undefined || title === null) return children;
  // Off: the native title, byte for byte as before (an empty title included).
  if (!componentTooltips) return React.cloneElement(children as React.ReactElement<{ title?: string }>, { title });
  if (!title) return children;
  const props = children.props as { 'aria-label'?: string; 'aria-describedby'?: string };
  const labelled = props['aria-label'] != null;
  // A title that was the control's only name becomes its aria-label. Any other
  // title was its description (a native title is read as one), and a tooltip
  // tags nothing for a screen reader: the text stays in a hidden element the
  // child names with aria-describedby. Not for a cut label (the text is on
  // screen) or a title equal to the control's own label.
  const asName = name && !labelled;
  const describe = !asName && !cut && props['aria-label'] !== title;
  const extra: Record<string, string> = {};
  if (asName) extra['aria-label'] = title;
  if (describe) extra['aria-describedby'] = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ');
  const child = Object.keys(extra).length > 0 ? React.cloneElement(children as React.ReactElement<Record<string, string>>, extra) : children;
  const tooltip = (
    <Tooltip
      content={title}
      side={side}
      wide
      delayDuration={HOST_TITLE_DELAY_MS}
      escapePassesThrough
      shouldOpen={(trigger) => {
        if (noHover() || (cut && !isTextCut(trigger))) return false;
        setContainer(tooltipContainerOf(trigger));
        return true;
      }}
      container={container}
    >
      {child}
    </Tooltip>
  );
  if (!describe) return tooltip;
  return (
    <>
      {tooltip}
      {/* `hidden`: never drawn or read in browse mode; aria-describedby still reads it. */}
      <span id={descriptionId} hidden data-host-title-description="">
        {title}
      </span>
    </>
  );
}
