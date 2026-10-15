import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { formatShortcutBindingText, formatShortcutBindingTokens } from '@plannotator/ui/shortcuts';
import { Icon } from '../icons';

/**
 * The one floating bar of full view (approval "inbox-full-view", A · Pill):
 * the pane's header, docked comments and bottom bar are gone, and this is
 * what is left over the file. Top right on a desktop, bottom right with
 * 44 px targets on a phone. In order: the pen (HTML, Annotate / Interact),
 * the comment count (opens the pane's Comments sheet over the file), the
 * position `N/M ⌄` (opens the file peek; on a phone it lives in the sheet),
 * and the eye (the tools back). A toolbar, first in the pane's tab order.
 */
export interface FullViewBarProps {
  phone: boolean;
  /** Annotate is armed (HTML). */
  armed: boolean;
  /** The pen, on an HTML file that takes comments. */
  onToggleArmed?: () => void;
  /** The comment count and its sheet; absent when the file takes no comments and no other file has any. */
  comments: {
    count: number;
    open: boolean;
    controls: string;
    onToggle: () => void;
    buttonRef: RefObject<HTMLButtonElement | null>;
  } | null;
  /** The position and its peek (a thread with two or more files, not on a phone). */
  position: {
    index: number;
    total: number;
    name: string;
    open: boolean;
    peekId: string;
    onOpenChange: (open: boolean) => void;
    /** The peek, drawn under the bar while open; it closes through `close` with its reason. */
    renderPeek: (close: (reason: 'key' | 'outside') => void) => ReactNode;
  } | null;
  /** The eye's chord (`Mod+Shift+X`, HTML only), shown in its tooltip. */
  chord: string | null;
  onEye: () => void;
  eyeRef: RefObject<HTMLButtonElement | null>;
  /** The Comments sheet is open over the file's right edge (desktop): the bar steps left of it. */
  shifted: boolean;
}

/** How long the eye's "Show tools" label stays on its first appearance (then it fades). */
export const EYE_LABEL_MS = 4000;
/** The label shows once per page session, on the first full view. */
let eyeLabelSeen = false;
/** Tests: show the eye's label again. */
export function resetFullViewEyeLabelForTests() {
  eyeLabelSeen = false;
}

function Keys({ binding }: { binding: string }) {
  return (
    <span className="flex items-center gap-1">
      {formatShortcutBindingTokens(binding).map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Tip({ text, binding, phone, children }: { text: string; binding?: string | null; phone: boolean; children: React.ReactElement }) {
  return (
    <Tooltip
      side={phone ? 'top' : 'bottom'}
      wide
      content={
        <span className="flex flex-col gap-1">
          <span>{text}</span>
          {binding && <Keys binding={binding} />}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

export function FullViewBar(props: FullViewBarProps) {
  const { phone, comments, position } = props;
  const posRef = useRef<HTMLButtonElement>(null);
  /** The peek closed from the keyboard or by a choice: focus back on the position (not after a press elsewhere). */
  const refocus = useRef(false);
  const peekOpen = position?.open ?? false;
  useEffect(() => {
    if (peekOpen) refocus.current = true;
    else if (refocus.current) {
      refocus.current = false;
      posRef.current?.focus({ preventScroll: true });
    }
  }, [peekOpen]);

  const eyeText = 'Show tools';
  // A first-time reader finds the way back: the eye says "Show tools" the first time the bar appears in this page session.
  const [eyeLabel, setEyeLabel] = useState<'on' | 'fading' | null>(() => (eyeLabelSeen ? null : 'on'));
  useEffect(() => {
    if (eyeLabel === null) return;
    eyeLabelSeen = true;
    const fade = setTimeout(() => setEyeLabel('fading'), EYE_LABEL_MS);
    const gone = setTimeout(() => setEyeLabel(null), EYE_LABEL_MS + 450);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
    // Once per mount: the timers run from the first appearance.
  }, []);
  const closePeek = (reason: 'key' | 'outside') => {
    // A press elsewhere on a desktop leaves focus where it went; Esc, Tab or a choice put it back on N/M.
    if (reason === 'outside' && !phone) refocus.current = false;
    position?.onOpenChange(false);
  };
  return (
    <div
      className={`ib-fvbar${phone ? ' ib-fvbar-phone' : ''}${props.shifted ? ' ib-shift' : ''}`}
      role="toolbar"
      aria-label="Full view"
      data-full-view-bar=""
    >
      {props.onToggleArmed && (
        <Tip text={props.armed ? 'Annotate: click an element or select text to comment. Esc to interact' : 'Interact: clicks reach the page. Click to annotate'} phone={phone}>
          <button
            type="button"
            className={`ib-fvb${props.armed ? ' ib-on' : ''}`}
            onClick={props.onToggleArmed}
            aria-pressed={props.armed}
            aria-label={props.armed ? 'Annotate mode' : 'Interact mode'}
            data-full-view-pen=""
          >
            <Icon name="pen" size={phone ? 18 : 16} />
          </button>
        </Tip>
      )}
      {comments && (
        <Tip text={comments.open ? 'Close the comments' : 'Comments'} phone={phone}>
          <button
            type="button"
            ref={comments.buttonRef}
            className={`ib-fvb ib-fvcount${comments.count === 0 ? ' ib-zero' : ''}${comments.open ? ' ib-open' : ''}`}
            onClick={comments.onToggle}
            onKeyDown={(event) => {
              // Escape on the count closes its open sheet (focus stays here); full view stays.
              if (event.key === 'Escape' && comments.open && !event.defaultPrevented) {
                event.preventDefault();
                comments.onToggle();
              }
            }}
            aria-expanded={comments.open}
            aria-controls={comments.controls}
            aria-label={`Comments, ${comments.count}`}
            data-full-view-comments=""
          >
            <Icon name="comment" size={phone ? 18 : 15} />
            <span>{comments.count}</span>
          </button>
        </Tip>
      )}
      {position && (
        <span className="ib-fvpos">
          <button
            type="button"
            ref={posRef}
            className="ib-fvb ib-fvposb"
            aria-haspopup="grid"
            aria-expanded={position.open}
            aria-controls={position.open ? position.peekId : undefined}
            aria-label={`${position.index + 1} of ${position.total}, ${position.name}. Show every file in this thread`}
            onClick={() => position.onOpenChange(!position.open)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && !position.open) {
                event.preventDefault();
                position.onOpenChange(true);
              }
            }}
            data-full-view-position=""
            data-peek-opener=""
          >
            <span>{position.index + 1}</span>
            <small>/{position.total}</small>
            <span className={`ib-stepchev${position.open ? ' ib-on' : ''}`} aria-hidden="true">
              <Icon name="chevD" size={12} />
            </span>
          </button>
          {position.open && (
            <div className="ib-fvpeek" data-step-list="">
              {position.renderPeek(closePeek)}
            </div>
          )}
        </span>
      )}
      <span className="ib-fvdv" aria-hidden="true" />
      <Tip text={eyeText} binding={props.chord} phone={phone}>
        <button
          type="button"
          ref={props.eyeRef}
          className="ib-fvb ib-fveye"
          onClick={props.onEye}
          aria-pressed="true"
          aria-label={eyeText}
          aria-description={props.chord ? `Shortcut: ${formatShortcutBindingText(props.chord)}` : undefined}
          data-full-view-eye=""
        >
          <Icon name="eyeOff" size={phone ? 19 : 16} />
          {eyeLabel && (
            <span className={`ib-fveye-label${eyeLabel === 'fading' ? ' ib-gone' : ''}`} aria-hidden="true" data-full-view-eye-label="">
              {eyeText}
            </span>
          )}
        </button>
      </Tip>
    </div>
  );
}
