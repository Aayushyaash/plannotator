import type { AskKind, TabSlept } from '../notify';
import { addressOf, browserName } from '../notifyStatus';
import { Icon } from '../icons';

/**
 * The line at the top of the list (record 6.1), in words that say why. It
 * stays on every load until it is resolved (askKind in notify.ts):
 * - `ask`: Turn on raises the browser's own prompt.
 * - `moved`: notifications were allowed at another address of this computer
 *   (the Inbox changed port, or was opened at 127.0.0.1), and this address has
 *   none. Drawn prominently: notifications are silently off until Allow.
 * - `blocked`: the browser blocked this address; a quiet line pointing at
 *   Settings, where the steps are.
 */
export function NotificationAsk({
  kind,
  onTurnOn,
  onNotNow,
  onSettings,
  movedFrom = null,
  soundOn = false,
}: {
  kind: AskKind;
  onTurnOn: () => void;
  onNotNow: () => void;
  /** Settings → General, where the blocked steps are. */
  onSettings?: () => void;
  /** The address notifications were allowed at (`moved`). */
  movedFrom?: string | null;
  /** The question sound is on (sound.ts): a fresh install learns it here, not from a dialog. */
  soundOn?: boolean;
}) {
  const browser = browserName();
  if (kind === 'blocked') {
    return (
      <div className="ib-askline ib-askquiet" role="region" aria-label="Desktop notifications" data-notification-ask={kind}>
        <Icon name="bell" />
        <span className="ib-grow ib-mut">
          {browser === 'this browser' ? 'This browser' : browser} blocks notifications for {window.location.host}, so you get no notice when an agent stops on you.
        </span>
        {onSettings && (
          <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onSettings}>
            How to allow
          </button>
        )}
        <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onNotNow}>
          Hide
        </button>
      </div>
    );
  }
  return (
    <div
      className={kind === 'moved' ? 'ib-askline ib-askmoved' : 'ib-askline'}
      role="region"
      aria-label="Desktop notifications"
      data-notification-ask={kind}
    >
      <Icon name={kind === 'moved' ? 'warn' : 'bell'} />
      <span className="ib-grow">
        {kind === 'ask' ? (
          <>
            <b>Get a desktop notice when an agent needs you.</b>{' '}
            <span className="ib-mut">
              When an agent starts a thread or asks you something. Your browser asks once.{soundOn && ' Sound is on.'}
            </span>
          </>
        ) : (
          <>
            <b>Notifications are off at this address.</b>{' '}
            <span className="ib-mut">
              You allowed them at {movedFrom ? addressOf(movedFrom) : 'another address'}; the Inbox is now at {window.location.host}. Allow them again. Reload or close any tab still open on the old address, so notices don't arrive twice.
            </span>
          </>
        )}
      </span>
      <button type="button" className="ib-btn ib-pri ib-sm" onClick={onTurnOn}>
        {kind === 'moved' ? 'Allow' : 'Turn on'}
      </button>
      <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onNotNow}>
        Not now
      </button>
    </div>
  );
}

/**
 * The browser put this tab to sleep in the background, so it could not
 * notify (notify.ts `TabSlept`). Said once, with how to keep it awake.
 */
export function TabSleptLine({ slept, onDismiss }: { slept: Exclude<TabSlept, null>; onDismiss: () => void }) {
  const chrome = browserName() === 'Chrome' || browserName() === 'Edge';
  return (
    <div className="ib-askline ib-askquiet" role="region" aria-label="Notifications paused" data-tab-slept={slept}>
      <Icon name="info" />
      <span className="ib-grow ib-mut">
        {slept === 'discarded'
          ? 'Your browser closed this tab in the background to save memory, so it could not notify you meanwhile.'
          : 'Your browser paused this tab in the background, so notices came late or not at all.'}
        {chrome && ` To keep it running: Settings → Performance → "Always keep these sites active" → add ${window.location.hostname}.`}
      </span>
      <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
