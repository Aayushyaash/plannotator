/**
 * Telling the person when an agent session needs a restart after an update
 * (owner approval "restart-warning", 2026-10-19; design record not in this
 * repo). Two pieces:
 *  - `RestartLine`: under the person's reply, when the session it goes to is
 *    working and has no Send now because it runs an older plugin ("Steps"):
 *    the reason, then "How to restart" folded open on click: type `/exit`
 *    (which stops the turn it is working on), then run a copyable
 *    `cd <folder> && claude --resume <id>`; `/restart` only as a shortcut
 *    where Claude Code has it (amended 2026-10-20: `/restart` is behind a
 *    per-account rollout, so the steps lead with what always works); and
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
            {note.command ? (
              <>
                Type <code>/exit</code> in that {name}, then run:
                <CommandLine text={note.command} label={`Copy the command that restarts this ${name} session`} />
              </>
            ) : (
              <>
                Type <code>/exit</code> in that {name}, then run <code>claude --resume</code> in its folder and pick the session.
              </>
            )}
            <p className="ib-rw-warn">Exiting now stops the turn it is working on; to keep it, wait until it finishes.</p>
          </li>
        </ol>
        {/* Only a shortcut: /restart (Claude Code 2.1.304+) is behind a per-account rollout and a setting. */}
        <p className="ib-rw-shortcut" data-restart-shortcut="">
          If your {name} has <code>/restart</code>, that does the same and keeps the session.
        </p>
        <p className="ib-rw-after">Your reply waits here and reaches it once it is back.</p>
      </div>
    </>
  );
}
