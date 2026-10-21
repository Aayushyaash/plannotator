/**
 * Telling the person when a Claude Code session needs `/reload-plugins` after
 * an update (owner approval "restart-warning", 2026-10-19, simplified
 * 2026-10-21: the obvious path leads, alone). Pieces:
 *  - `ReloadLead`: one large sentence, "Type /reload-plugins in …", with a
 *    Copy that copies `/reload-plugins`. When the installed plugin is itself
 *    behind this Inbox, two steps instead: the update command with Copy, then
 *    `/reload-plugins`.
 *  - `Fold`: the manual path, folded by default behind one question.
 *  - `RestartLine`: under the person's reply when the session it goes to has
 *    no Send now because it runs an older plugin. The lead, then "Still no
 *    Send now after reloading?" opening `/exit` and the resume command.
 *  - `CopyCommand`: every Copy button. A copy says so in a polite live region.
 * No keyboard shortcut. Real buttons with names; the fold uses
 * aria-expanded / aria-controls.
 */

import { useId, useRef, useState, type ReactNode } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { RestartNote } from '../deliveryLine';
import { Icon } from '../icons';

/** How long Copy reads "Copied". */
export const RESTART_COPIED_MS = 2000;
export const RESTART_COPIED_ANNOUNCEMENT = 'Restart command copied.';
export const UPDATE_COPIED_ANNOUNCEMENT = 'Update command copied.';
export const RELOAD_COMMAND = '/reload-plugins';
export const RELOAD_COPIED_ANNOUNCEMENT = '/reload-plugins copied.';

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
export function CommandLine({ text, label, announcement }: { text: string; label: string; announcement?: string }) {
  return (
    <div className="ib-rw-cmd">
      <code>{text}</code>
      <CopyCommand text={text} label={label} {...(announcement ? { announcement } : {})} />
    </div>
  );
}

/** Copy `/reload-plugins`. */
function ReloadCopy() {
  return <CopyCommand text={RELOAD_COMMAND} label="Copy /reload-plugins" announcement={RELOAD_COPIED_ANNOUNCEMENT} />;
}

/**
 * The one thing to do, large and alone: "Type /reload-plugins {where}." with
 * Copy. With `updateCommand` (the installed plugin is behind this Inbox), two
 * numbered steps: the update command, then `/reload-plugins`.
 */
export function ReloadLead({ where, updateCommand }: { where: string; updateCommand?: string | null }) {
  if (updateCommand) {
    return (
      <ol className="ib-rl-lead ib-rl-two" data-reload-lead="update_plugin">
        <li>
          <span>Update the plugin:</span>
          <CommandLine text={updateCommand} label="Copy the command that updates Plannotator's Claude Code plugin" announcement={UPDATE_COPIED_ANNOUNCEMENT} />
        </li>
        <li>
          <div className="ib-rl-line">
            <span>
              Then type <code>{RELOAD_COMMAND}</code> {where}.
            </span>
            <ReloadCopy />
          </div>
        </li>
      </ol>
    );
  }
  return (
    <p className="ib-rl-lead ib-rl-line" data-reload-lead="restart">
      <span>
        Type <code>{RELOAD_COMMAND}</code> {where}.
      </span>
      <ReloadCopy />
    </p>
  );
}

/** The manual path, folded by default behind one question. */
export function Fold({ question, children }: { question: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ib-rl-fold">
      <button type="button" className="ib-rw-lnk" aria-expanded={open} aria-controls={id} data-restart-toggle="" onClick={() => setOpen((was) => !was)}>
        <span>{question}</span>
        <Icon name="chevD" className="ib-rw-chev" />
      </button>
      <div className="ib-rw-steps" id={id} hidden={!open} data-restart-steps="">
        {children}
      </div>
    </div>
  );
}

/** Under the reply: what brings Send now back, then the manual path, folded. */
export function RestartLine({ note, name }: { note: RestartNote; name: string }) {
  const updating = note.fix === 'update_plugin';
  return (
    <div className="ib-rw-note" data-restart-note={note.fix}>
      <ReloadLead where={`in that ${name} to get Send now`} updateCommand={updating ? note.updateCommand : null} />
      <Fold question="Still no Send now after reloading?">
        <div data-restart-fallback="">
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
          <p className="ib-rw-warn">/exit stops the turn it is working on.</p>
        </div>
        <p className="ib-rw-after">Your reply waits here.</p>
      </Fold>
    </div>
  );
}
