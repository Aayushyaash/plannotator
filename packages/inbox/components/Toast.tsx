import { useLayoutEffect, useState } from 'react';
import { Icon, type IconName } from '../icons';

/** `thumb`: 👍 Looks good (the emoji itself, as plan review's button draws it). */
export type InboxToastIcon = 'check' | 'warn' | 'archive' | 'mute' | 'thumb';

export interface InboxToastModel {
  /** Bumped per toast, so a new one replays its entrance. */
  id: number;
  /** `warn`: the icon in the warning colour (an agent stopped or held up, an error). */
  icon: InboxToastIcon;
  /** The bold first words ("Marked read"). */
  lead: string;
  /** What a phone says instead ("Read"). */
  phoneLead?: string;
  /** The muted rest of the line; shown whole, wrapping to a second line when it does not fit. */
  detail?: string;
  /** An error: its message stays whole and may wrap. */
  wrap?: boolean;
  onUndo?: () => void;
  /** Desktop only (a phone's thread foot has Reply). */
  onReply?: () => void;
  /** One more action (compose: Open the thread just sent, or Drafts). */
  action?: { label: string; onPress: () => void };
  /**
   * What the live region says in place of lead and detail, when the line is
   * kept short for one line and a screen reader should still hear the whole
   * sentence (compose's Sent toast).
   */
  speech?: string;
}

const ICONS: Record<Exclude<InboxToastIcon, 'thumb'>, IconName> = { check: 'checkCircle', warn: 'warn', archive: 'archive', mute: 'mute' };

/**
 * What the window's live region says for a toast, as sentences, and how to
 * undo it when it can be undone: "Marked read. Moves to Quiet. Press Z to
 * undo." (a phone has no Z: "Undo is available.").
 */
export function toastSpeech(toast: Pick<InboxToastModel, 'lead' | 'detail' | 'onUndo' | 'speech'>, phone = false): string {
  const sentence = (text: string) => (/[.!?…”"]$/.test(text) ? text : `${text}.`);
  const said = toast.speech ? sentence(toast.speech) : toast.detail ? `${sentence(toast.lead)} ${sentence(toast.detail)}` : sentence(toast.lead);
  if (!toast.onUndo) return said;
  return `${said} ${phone ? 'Undo is available.' : 'Press Z to undo.'}`;
}

/**
 * The window's one toast (Mark read, Archive, Unarchive, the sound): one
 * line in the look of Plannotator's other toasts (design record
 * "inbox-toast", approved 2026-10-14): an icon, a bold lead, a muted detail,
 * and Undo (`Z` while it is up). No close: it leaves after 7 s.
 * It never takes focus; the window's live region says it. Its words always
 * show whole: a detail that does not fit one line wraps to a second.
 */
export function InboxToast({ toast, phone = false }: { toast: InboxToastModel; phone?: boolean }) {
  return phone ? <PhoneToast key={toast.id} toast={toast} /> : <DesktopToast key={toast.id} toast={toast} />;
}

function toastClass(toast: InboxToastModel, phone: boolean): string {
  const actions = !!toast.onUndo || !!toast.action || (!phone && !!toast.onReply);
  return [
    'ib-toast',
    phone ? 'ib-toast-phone' : '',
    toast.icon === 'warn' ? 'ib-toast-warn' : '',
    toast.wrap ? 'ib-toast-wrap' : '',
    actions ? '' : 'ib-toast-solo',
  ]
    .filter(Boolean)
    .join(' ');
}

function ToastBody({ toast, phone }: { toast: InboxToastModel; phone: boolean }) {
  const reply = !phone && toast.onReply;
  return (
    <>
      {toast.icon === 'thumb' ? (
        <span className="ib-temoji" aria-hidden="true">
          👍
        </span>
      ) : (
        <Icon name={ICONS[toast.icon]} size={16} />
      )}
      <span className="ib-tsay">
        <span className="ib-tlead">{phone ? (toast.phoneLead ?? toast.lead) : toast.lead}</span>
        {toast.detail && <span className="ib-tdetail">{toast.detail}</span>}
      </span>
      {(reply || toast.onUndo || toast.action) && (
        <span className="ib-tacts">
          {toast.action && (
            <button type="button" className="ib-tghost" onClick={toast.action.onPress} data-toast-action="">
              {toast.action.label}
            </button>
          )}
          {reply && (
            <button type="button" className="ib-tghost" onClick={toast.onReply} data-toast-reply="">
              Reply
            </button>
          )}
          {toast.onUndo && (
            <button type="button" className="ib-tundo" onClick={toast.onUndo} data-toast-undo="" aria-keyshortcuts={phone ? undefined : 'Z'}>
              Undo
              {!phone && <kbd aria-hidden="true">Z</kbd>}
            </button>
          )}
        </span>
      )}
    </>
  );
}

/**
 * A desktop toast: centered on the window, 16 px from its bottom edge, at
 * most 520 px wide and 16 px from each side (inbox.css), whatever is open
 * (owner, 2026-10-18: a toast is brief, so it may cover Reply or a file's
 * strip for a moment rather than move around them).
 */
function DesktopToast({ toast }: { toast: InboxToastModel }) {
  return (
    <div className={toastClass(toast, false)} data-inbox-toast="">
      <ToastBody toast={toast} phone={false} />
    </div>
  );
}

/**
 * The open thread's foot, measured while the toast is up: the toast sits above
 * it whatever its height (the reply box open, a wrapped row, the safe area).
 * Null when no thread's foot is on screen (the list, an open file).
 */
function useFootHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const foot = document.querySelector<HTMLElement>('section.ib-pane .ib-pfoot');
    if (!foot) return;
    const read = () => {
      const box = foot.getBoundingClientRect();
      setHeight(box.height > 0 ? box.height : null);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(foot);
    return () => observer.disconnect();
  }, []);
  return height;
}

/**
 * A phone's toast: across the window above the thread's foot, its words and
 * Undo (a 44 px target), never Reply (the foot has it) or the Z hint.
 */
function PhoneToast({ toast }: { toast: InboxToastModel }) {
  const foot = useFootHeight();
  return (
    <div className={toastClass(toast, true)} data-inbox-toast="" style={foot !== null ? { bottom: `${Math.round(foot) + 8}px` } : undefined}>
      <ToastBody toast={toast} phone />
    </div>
  );
}
