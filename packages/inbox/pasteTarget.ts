/**
 * A paste aimed at nothing goes to the text field the person was writing in.
 *
 * Dictation apps (Hex, and most others on macOS) insert their text by putting
 * it on the clipboard and posting a synthetic ⌘V to the front app. The paste
 * lands in whatever has focus at that moment. In the Inbox, focus often leaves
 * the field the person is writing in without them noticing: a click on a
 * question card's choice moves it to that radio or checkbox, a click on a
 * message's text or on a chip in the reply box moves it to the page, while
 * the reply box stays open (and keeps its border). A ⌘V then pastes into
 * nothing, and the dictated words are lost, seemingly at random.
 *
 * So: the window remembers the text fields that last had focus (the reply
 * box, a question card's note or Other field, compose, a comment box, any
 * input), and when a ⌘V (Ctrl+V off macOS) arrives while focus is on
 * something that takes no text, it puts focus back in the newest of them that
 * is still on screen, the caret where the person left it (a range they had
 * selected collapses to its end, so the dictation replaces nothing), before
 * the browser runs the paste. The keydown is never cancelled, so the
 * browser's own paste runs (Chrome runs it after the page has handled the
 * keydown), now into the field.
 *
 * Nothing changes when focus is already in a text field or inside a frame (an
 * attached HTML page), when text is selected on the page (the person is about
 * to comment on it), or when no remembered field is on screen: gone, hidden,
 * disabled, read-only, scrolled out of view, behind a modal dialog, under a
 * full-screen file or a guided review, or with something else drawn over it.
 */

import { isModKeyHeld } from '@plannotator/ui/utils/platform';

/** Input types that take typed text. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/**
 * What covers the thread while it stays laid out under it: a file shown full
 * screen (`.ib-view.ib-full`, fixed over the window) and an open guided review
 * (`.ib-viewer`, over the thread pane). A field outside such a cover is hidden
 * from the person, unless the field is drawn over the cover (a comment box, the
 * search palette or compose, which are portaled to the page's end): the hit
 * test at its first line decides that.
 */
const COVERS = '.ib-view.ib-full, .ib-viewer';
const MODALS = 'dialog[open], [aria-modal="true"]';

/** How many recently focused fields are remembered: the newest still on screen takes the paste. */
const REMEMBERED = 8;

type TextField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function isTextField(target: EventTarget | null | undefined): target is TextField {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}

type KeyFields = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>;

/**
 * A ⌘V / Ctrl+V keydown (Shift allowed: paste and match style). When the key
 * names a Latin letter, that letter decides: on Dvorak, Colemak-DH or Workman
 * the key in V's place types another letter, and ⌘ with it is that letter's
 * command (⌘K, ⌘D, ⌘C), not paste. Only a key that names no Latin letter (a
 * Cyrillic or Greek layout, where the shortcut still pastes) is read by its
 * physical place.
 */
export function isPasteKey(event: KeyFields, mod: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean = isModKeyHeld): boolean {
  if (event.isComposing || event.altKey || !mod(event)) return false;
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === 'v';
  return event.code === 'KeyV';
}

function isModal(el: Element): boolean {
  if (!(el instanceof HTMLDialogElement)) return true; // [aria-modal="true"]
  try {
    return el.matches(':modal');
  } catch {
    return true; // no :modal in this browser: count an open dialog as modal (refusing is the safe side)
  }
}

/**
 * Where the field's first line is on screen, by the topmost element there:
 * `top` (the field, or the box drawn behind it such as a highlight mirror),
 * `covered` (something else is drawn over it), `offscreen` (the point is
 * outside the window), or `unknown` (the browser cannot tell).
 */
type Sight = 'top' | 'covered' | 'offscreen' | 'unknown';

function sight(field: TextField): Sight {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  if (!view) return 'unknown';
  const rect = field.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + Math.min(rect.height / 2, 12);
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return 'offscreen';
  if (typeof doc.elementFromPoint !== 'function') return 'unknown';
  const hit = doc.elementFromPoint(x, y);
  if (!hit) return 'unknown';
  // Scrolled out of its pane while still inside the window: the pane's own edge, or what lies
  // beside it, is hit, which is "covered" like anything drawn over it.
  return hit === field || field.contains(hit) || hit.contains(field) ? 'top' : 'covered';
}

function usable(field: TextField): boolean {
  if (!field.isConnected) return false;
  if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && (field.disabled || field.readOnly)) return false;
  if (field.closest('[inert], [aria-hidden="true"]')) return false;
  if (field.getClientRects().length === 0) return false;
  const doc = field.ownerDocument;
  // A modal dialog owns the keys: only a field inside it counts.
  for (const modal of doc.querySelectorAll(MODALS)) {
    if (isModal(modal) && !modal.contains(field)) return false;
  }
  const seen = sight(field);
  if (seen === 'covered' || seen === 'offscreen') return false;
  // A full-screen file or a guided review hides what is under it, though it stays laid out. A field
  // outside one counts only when the hit test shows it on top (a box portaled over the cover).
  for (const cover of doc.querySelectorAll(COVERS)) {
    if (!cover.contains(field) && seen !== 'top') return false;
  }
  return true;
}

/**
 * Text the person selected on the page (outside any text field): a ⌘V is not
 * aimed at a field then. A document's selection toolbar counts too: ui's
 * viewer draws the selected words as a pending highlight and clears the
 * browser's own selection while its toolbar (Delete, Comment, labels) shows.
 */
function pageSelection(doc: Document): boolean {
  const toolbar = doc.querySelector('[data-pn-annotation-toolbar-row]');
  if (toolbar && toolbar.getClientRects().length > 0) return true;
  return nativeSelection(doc);
}

function nativeSelection(doc: Document): boolean {
  const selection = doc.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (!selection.toString().trim()) return false;
  const node = selection.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  // A selection inside a text field is that field's own, not a selection on the page.
  return !(el && (isTextField(el) || el.closest('textarea, input, [contenteditable="true"], [contenteditable=""]')));
}

/**
 * Install on a window; returns the uninstall. `mod` is for tests (the
 * platform's own modifier by default).
 */
export function installPasteFollowsField(win: Window = window, mod?: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean): () => void {
  const doc = win.document;
  // The fields that last had focus, newest first. One field is not enough: a field that took focus
  // and then went away (the search palette, closed with Escape) must not hide the one before it.
  let recent: TextField[] = [];
  // Where each field's caret was when it lost focus. Kept apart from `recent`, so focusing the field
  // again (which fires focusin) cannot clear it before it is put back.
  const carets = new WeakMap<TextField, number>();

  const remember = (event: FocusEvent) => {
    const target = event.target;
    if (!isTextField(target)) return;
    recent = [target, ...recent.filter((field) => field !== target && field.isConnected)].slice(0, REMEMBERED);
  };
  const leave = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) || !isTextField(target)) return;
    try {
      if (target.selectionEnd !== null) carets.set(target, target.selectionEnd);
    } catch {
      // input types without a selection (number, email)
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPasteKey(event, mod)) return;
    const active = doc.activeElement;
    // Already in a text field, or in a frame (the page in it gets the keys): the paste is aimed.
    if (isTextField(active) || active instanceof HTMLIFrameElement) return;
    // Text selected on the page: the person is commenting on it, keep the selection and its toolbar.
    if (pageSelection(doc)) return;
    const field = recent.find(usable);
    if (!field) return;
    // Read before focus(): a range the person selected earlier, no longer visible, would otherwise
    // be what the paste replaces.
    const caret = carets.get(field);
    field.focus({ preventScroll: true });
    if (doc.activeElement !== field) return;
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      try {
        const length = field.value.length;
        const at = Math.min(caret ?? field.selectionEnd ?? length, length);
        // Collapsed at its end: the paste lands where the caret was and replaces nothing.
        field.setSelectionRange(at, at, 'none');
      } catch {
        // input types without a selection
      }
    }
  };

  doc.addEventListener('focusin', remember, true);
  doc.addEventListener('focusout', leave, true);
  win.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('focusin', remember, true);
    doc.removeEventListener('focusout', leave, true);
    win.removeEventListener('keydown', onKey, true);
  };
}
