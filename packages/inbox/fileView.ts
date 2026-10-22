/**
 * How an attachment opens (approval "inbox-side-by-side", 2026-10-22).
 *
 * A window with room for two panes shows a file one of two ways: "Side by
 * side" (the file beside the thread, its comments at its edge) or "Full
 * screen" (the file fills the window under one floating toolbar). The view
 * the person last picked with a button (the pane header's "Side by side |
 * Full screen" switch, or full screen's "Side by side") is remembered and
 * applies to every file kind. Until they pick, today's rule holds: an HTML
 * page and an image shown in a message's text open full screen, everything
 * else side by side.
 *
 * The view also rides the address (`&view=full|side`), so a reload or a
 * shared link opens the same way; a link without it uses the remembered
 * choice, then the rule. A phone, and a window too narrow to keep the thread
 * beside a file (stack.ts), always shows the file full screen and never
 * saves a choice.
 *
 * The choice is a cookie, like the Inbox's other window-only layout choices
 * (the sidebar, the list width, the comments drawer): cookies ignore the
 * port, so the choice holds when the Inbox comes back on another port, where
 * localStorage (per origin) would forget it.
 */
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';

export type FileView = 'full' | 'side';

export const FILE_VIEW_COOKIE = 'plannotator-inbox-file-view';

/** A value read from the address or the cookie: only the two views count. */
export function parseFileView(value: string | null | undefined): FileView | null {
  return value === 'full' || value === 'side' ? value : null;
}

/** The view the person last picked with a button, or null before they pick. */
export function readFileViewChoice(): FileView | null {
  return parseFileView(storage.getItem(FILE_VIEW_COOKIE));
}

/** Remember a picked view; null forgets it (the toast's Undo of a first pick). */
export function writeFileViewChoice(view: FileView | null): void {
  if (view === null) storage.removeItem(FILE_VIEW_COOKIE);
  else storage.setItem(FILE_VIEW_COOKIE, view);
}

/** Today's rule, before any choice: an HTML page and an image from a message's text open full screen. */
export function kindDefaultView(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>): FileView {
  return readInboxAttachmentKind(attachment.kind) === 'html' || attachment.ref !== undefined ? 'full' : 'side';
}

export interface FileViewInputs {
  /** The view the address names (`&view=`), or null for a link without one. */
  address: FileView | null;
  /** The remembered choice, or null before the person picks. */
  choice: FileView | null;
  /** A phone, or a window too narrow for the file beside the thread: full screen only. */
  narrow: boolean;
}

/**
 * The view a file is shown in: full screen where the window has no room
 * for two panes; else the address; else the remembered choice; else today's
 * rule by kind.
 */
export function fileViewFor(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>, inputs: FileViewInputs): FileView {
  if (inputs.narrow) return 'full';
  return inputs.address ?? inputs.choice ?? kindDefaultView(attachment);
}

/** The view a file opens in when nothing names one (a tile, a link, a comment card): the choice, else the rule. */
export function openingView(attachment: Pick<InboxAttachmentState, 'kind' | 'ref'>): FileView {
  return readFileViewChoice() ?? kindDefaultView(attachment);
}

/**
 * The same screen, whatever view each hash names: a hash with `view=`
 * dropped. Back from a linked page compares with this, because the entry it
 * was opened from still names the view it had then (a press on the switch
 * replaced only the entry on screen).
 */
export function hashWithoutView(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('view');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

export function sameScreenAnyView(a: string, b: string): boolean {
  return hashWithoutView(a) === hashWithoutView(b);
}
