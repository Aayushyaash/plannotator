/**
 * Telling the person when an agent session needs a restart after an update
 * (owner approval "restart-warning", 2026-10-19; design record not in this
 * repo). Two pieces:
 *  - `RestartLine`: under the person's reply, when the session it goes to is
 *    working and has no Send now because it runs an older plugin ("Steps"):
 *    the reason, then "How to restart" folded open on click: type `/restart`
 *    (Claude Code 2.1.304+, keeps the session), and folded under it the
 *    fallback for when it isn't there: `/exit` (which stops the turn it is
 *    working on), then a copyable `cd <folder> && claude --resume <id>`; and
 *    that the reply waits here.
 *  - `CopyCommand`: the Copy button both places use. A copy says so in a
 *    polite live region ("Restart command copied.").
 * No keyboard shortcut. Real buttons with names; the disclosure uses
 * aria-expanded / aria-controls.
 */

import { useId, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { RestartNote } from '../deliveryLine';
import { Icon } from '../icons';

/** How long Copy reads "Copied". */
export const RESTART_COPIED_MS = 2000;
export const RESTART_COPIED_ANNOUNCEMENT = 'Restart command copied.';
export const UPDATE_COPIED_ANNOUNCEMENT = 'Update command copied.';

/** Copy a command, with a short "Copied" and one polite announcement. */
export function CopyCommand({ text, label, short = 'Copy', announcement = RESTART_COPIED_ANNOUNCEMENT }: { text: string; label: string; short?: string; announcement?: string }) {
  const [copied, setCopied] = useState(false);
  const [said, setSaid] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <>
      <button
        type="button"
        className="ib-rw-copy"
        data-copied={copied ? '' : undefined}
        aria-label={label}
        data-restart-copy=""
        onClick={async () => {
          const ok = await copyTextToClipboard(text);
          setSaid('');
          // A fresh string each time, so a second copy is said again.
          setTimeout(() => setSaid(ok ? announcement : "Couldn't copy the command."), 30);
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), RESTART_COPIED_MS);
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        <span>{copied ? 'Copied' : short}</span>
      </button>
      <span className="ib-sr" role="status" aria-live="polite" data-restart-live="">
        {said}
      </span>
    </>
  );
}

/** A command on its own line, with Copy. */
function CommandLine({ text, label, announcement }: { text: string; label: string; announcement?: string }) {
  return (
    <div className="ib-rw-cmd">
      <code>{text}</code>
      <CopyCommand text={text} label={label} {...(announcement ? { announcement } : {})} />
    </div>
  );
}

/** The line under the reply: why there is no Send now, and how to bring it back. */
export function RestartLine({ note, name }: { note: RestartNote; name: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const stepsId = `${id}-steps`;
  const updating = note.fix === 'update_plugin';
  return (
    <>
      <span className="ib-rw-note" data-restart-note={note.fix}>
        <Icon name="refresh" />
        <span>
          {note.text}
          <button type="button" className="ib-rw-lnk" aria-expanded={open} aria-controls={stepsId} data-restart-toggle="" onClick={() => setOpen((was) => !was)}>
            <span>{open ? 'Hide steps' : updating ? 'How to update' : 'How to restart'}</span>
            <Icon name="chevD" className="ib-rw-chev" />
          </button>
        </span>
      </span>
      <div className="ib-rw-steps" id={stepsId} hidden={!open} data-restart-steps="">
        <ol>
          {updating && note.updateCommand && (
            <li>
              Update the plugin, in any terminal:
              <CommandLine text={note.updateCommand} label="Copy the command that updates Plannotator's Claude Code plugin" announcement={UPDATE_COPIED_ANNOUNCEMENT} />
            </li>
          )}
          <li>
            Type <code>/restart</code> in that {name}. It restarts and keeps the session.
            {/* The fallback, folded under it: /restart is behind a setting, and refuses while background work runs,
                in a background session and in the agents view (Claude Code 2.1.304). */}
            <div className="ib-rw-fallback" data-restart-fallback="">
              {note.command ? (
                <>
                  If <code>/restart</code> isn&apos;t there: type <code>/exit</code>, then run:
                  <CommandLine text={note.command} label={`Copy the command that restarts this ${name} session`} />
                </>
              ) : (
                <>
                  If <code>/restart</code> isn&apos;t there: type <code>/exit</code>, then run <code>claude --resume</code> in its folder and pick the session.
                </>
              )}
              <p className="ib-rw-warn">Exiting now stops the turn it is working on; to keep it, wait until it finishes.</p>
            </div>
          </li>
        </ol>
        <p className="ib-rw-after">Your reply waits here and reaches it once it is back.</p>
      </div>
    </>
  );
}
