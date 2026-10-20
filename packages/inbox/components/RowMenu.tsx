import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon, type IconName } from '../icons';
import { rowMenuActions, type RowMenuAction } from '../rowMenu';

export interface ThreadRowMenuProps {
  className: string;
  /** Finds a listed row by its thread id (the menu is one for the whole list). */
  rowOf: (threadId: string) => InboxListRow | null;
  /** Mark read and Move back are offered (the list has the row's hover action). */
  canMarkRead: boolean;
  onAction: (row: InboxListRow, action: RowMenuAction) => void;
  /** The row whose menu is open (its muted background), or null when it closes. */
  onTarget: (threadId: string | null) => void;
  /** No menu (the host gave no actions): the browser's own. */
  disabled?: boolean;
  children: ReactNode;
}

const LABELS: Record<RowMenuAction, { label: string; icon: IconName }> = {
  'copy-link': { label: 'Copy link', icon: 'link' },
  'copy-id': { label: 'Copy thread ID', icon: 'hash' },
  read: { label: 'Mark read', icon: 'checkCircle' },
  unread: { label: 'Move back', icon: 'inbox' },
  archive: { label: 'Archive', icon: 'archive' },
};

/** A touch (or a long press that a phone turns into `contextmenu`) never opens the menu: phones have none. */
const TOUCH_WINDOW_MS = 1500;

/** The row a `contextmenu` event names: a wide or two-line row (its wrapper, `data-row`), or a phone's row. */
function rowElementOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest<HTMLElement>('[data-row]');
  if (wrapper) return wrapper.querySelector<HTMLElement>('[data-thread-id]');
  return target.closest<HTMLElement>('.ib-mrow[data-thread-id]');
}

/**
 * The thread rows' right-click menu: one menu for the whole list (its body is
 * the trigger), aimed at the row the right-click (or the platform's
 * context-menu key, or Shift+F10, on a focused row) lands on. Copy link, Copy
 * thread ID, then Mark read (or Move back) and Archive where they apply.
 * Anywhere else in the list the browser's own menu shows. Opening it never
 * opens the thread or moves the selection; Escape and Tab put focus back on
 * the row. A touch never opens it (no long press: phones have no menu here).
 * The look is the project menu's (`.ib-pm`).
 */
export const ThreadRowMenu = forwardRef<HTMLDivElement, ThreadRowMenuProps>(function ThreadRowMenu(props, ref) {
  const body = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => body.current!, []);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const [target, setTarget] = useState<InboxListRow | null>(null);
  const [open, setOpen] = useState(false);
  const targetId = useRef<string | null>(null);
  const lastTouch = useRef(0);
  const close = () => {
    setOpen(false);
    aim(null);
  };
  const aim = (row: InboxListRow | null) => {
    targetId.current = row?.thread_id ?? null;
    setTarget(row);
    props.onTarget(row?.thread_id ?? null);
  };
  /** The row's own button now (it may have been drawn again while the menu was open). */
  const rowButton = (): HTMLElement | null => {
    const id = targetId.current;
    if (!id || !body.current) return null;
    return body.current.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`);
  };
  const actions = target ? rowMenuActions(target, props.canMarkRead) : [];
  const copies = actions.filter((a) => a === 'copy-link' || a === 'copy-id');
  const writes = actions.filter((a) => a !== 'copy-link' && a !== 'copy-id');
  const item = (action: RowMenuAction) => (
    <Menu.Item
      key={action}
      className="ib-pmi"
      label={LABELS[action].label}
      data-row-action={action}
      onClick={() => {
        if (target) props.onAction(target, action);
      }}
    >
      <Icon name={LABELS[action].icon} size={15} />
      {LABELS[action].label}
    </Menu.Item>
  );
  return (
    <ContextMenu.Root
      disabled={props.disabled}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) aim(null);
      }}
    >
      <ContextMenu.Trigger
        ref={body}
        className={props.className}
        // Buttons and the empty list's link keep the platform's own long-press callout.
        style={{ WebkitTouchCallout: 'default' }}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') lastTouch.current = Date.now();
        }}
        // No long press: Base UI's touch handler never runs.
        onTouchStart={(event) => event.preventBaseUIHandler()}
        onKeyDown={(event) => {
          // The context-menu key and Shift+F10 on a focused row. Chromium on macOS (and Safari) send no
          // `contextmenu` for them, so the list sends one at the row; where the browser would, its own is
          // cancelled with the keydown.
          if (props.disabled || event.nativeEvent.isComposing) return;
          // Tab before focus has moved into the menu: it closes, and focus stays on the row.
          if (open && event.key === 'Tab') {
            event.preventDefault();
            close();
            return;
          }
          const key = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey);
          if (!key) return;
          const button = rowElementOf(event.target);
          if (!button) return;
          event.preventDefault();
          const rect = button.getBoundingClientRect();
          button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 24, clientY: rect.bottom }));
        }}
        onContextMenu={(event) => {
          if (props.disabled) return;
          const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
          const touch = pointerType === 'touch' || (!pointerType && Date.now() - lastTouch.current < TOUCH_WINDOW_MS);
          const button = touch ? null : rowElementOf(event.target);
          const row = button ? props.rowOf(button.getAttribute('data-thread-id')!) : null;
          if (!row) {
            // Not on a row (a band, the Show line, the empty list), or a touch: the browser's own menu.
            // Base UI also cancels any `contextmenu` inside its trigger from a document listener: stopping the
            // event at the list keeps the browser's menu (a link's "Open in new tab", for one).
            event.preventBaseUIHandler();
            event.stopPropagation();
            return;
          }
          aim(row);
        }}
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup
            className="ib-pm"
            aria-label={target?.subject ?? 'Thread'}
            data-row-menu={target?.thread_id}
            // Focus goes back to the row (Escape, Tab, an item), never the page.
            finalFocus={() => rowButton() ?? true}
            onKeyDown={(event) => {
              // Tab leaves the menu for the row it came from (Base UI keeps focus in a context menu).
              if (event.key !== 'Tab') return;
              event.preventDefault();
              close();
            }}
          >
            {copies.map(item)}
            {writes.length > 0 && <Menu.Separator className="ib-pm-sep" />}
            {writes.map(item)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
