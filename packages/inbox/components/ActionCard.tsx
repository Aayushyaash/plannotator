/**
 * A to-do's card in its message (approval "inbox-next-actions", direction "In
 * the thread"): what the agent needs the person to go and do, why, where (an
 * Open button for a link, a command to copy), what the agent watches, and
 * Done / Can't do it… / Add note. Done and Can't do it are recorded at once and
 * go to the agent after a 10 s Undo window (as 👍 Looks good): nothing is sent
 * inside the window.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { INBOX_ACTION_NOTE_MAX } from '@plannotator/core/inbox-actions';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { actionCardState, type ActionCardState } from '../actions';
import { clockTime } from '../format';
import { Icon } from '../icons';

export interface ActionMark {
  outcome: 'done' | 'cant';
  note?: string | null;
}

export interface ActionCardProps {
  action: InboxQuestion;
  /** "To do 2 of 3" when the message has several. */
  number: number;
  total: number;
  /** The agent that asked, as the person sees it ("Claude Code"). */
  agent: string;
  /** The card takes no Done (the person's own thread is archived, a phone surface, a test). */
  readOnly?: boolean;
  /** Done or Can't do it (`mark`), or the Undo (`null`). Resolves false when it was refused. */
  onMark: (mark: ActionMark | null) => Promise<boolean>;
}

const BADGE: Record<ActionCardState, { label: string; className: string } | null> = {
  open: null,
  pending: { label: 'Sending', className: 'ib-badge ib-b-mut' },
  done: { label: 'Done', className: 'ib-badge ib-b-ok' },
  seen: { label: 'Done', className: 'ib-badge ib-b-ok' },
  cant: { label: "Can't do it", className: 'ib-badge ib-b-stop' },
  'set-aside': { label: 'Set aside', className: 'ib-badge ib-b-mut' },
  archived: { label: 'Closed', className: 'ib-badge ib-b-mut' },
  replaced: { label: 'Replaced', className: 'ib-badge ib-b-mut' },
};

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function ActionCard({ action, number, total, agent, readOnly = false, onMark }: ActionCardProps) {
  const state = actionCardState(action);
  const facts = action.action ?? { where: null, where_url: null, run: null, watching: null };
  const result = action.action_result ?? null;
  const [composing, setComposing] = useState<'note' | 'cant' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const open = state === 'open';
  useEffect(() => {
    if (composing) areaRef.current?.focus();
  }, [composing]);
  useEffect(() => {
    if (!open) setComposing(null);
  }, [open]);

  const mark = async (next: ActionMark | null) => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onMark(next);
      if (ok) {
        setComposing(null);
        setText('');
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!facts.run) return;
    const ok = await copyTextToClipboard(facts.run);
    setCopied(ok ? 'ok' : 'failed');
    window.setTimeout(() => setCopied(null), 2000);
  };

  const pillFor = (): { label: string; className: string } | null => {
    if (state !== 'open') return BADGE[state];
    if (action.stopped !== null) return { label: 'Stopped', className: 'ib-badge ib-b-stop' };
    if (action.holds_up.length > 0) return { label: `Holds up ${action.holds_up.length}`, className: 'ib-badge ib-b-hold' };
    return null;
  };
  const pill = pillFor();
  const when = result ? clockTime(result.at) : '';
  const settled = (() => {
    if (state === 'pending' && result) {
      return (
        <>
          <span>
            {result.outcome === 'cant' ? `You can't do it: “${result.note ?? ''}”` : `You marked it done, ${when}${result.note ? ' with a note' : ''}`}. Goes to {agent} in a few seconds.
          </span>
          {!readOnly && (
            <button type="button" className="ib-act-undo" data-action-undo="" onClick={() => void mark(null)} disabled={busy}>
              Undo
            </button>
          )}
        </>
      );
    }
    if (state === 'done' && result) return <span>You marked it done, {when}{result.note ? ' with a note' : ''}. Sent to {agent}.</span>;
    if (state === 'cant' && result) return <span>You can't do it: “{result.note ?? ''}” Sent to {agent}.</span>;
    if (state === 'seen' && result) return <span>{agent} saw it done, {when}.</span>;
    if (state === 'set-aside') return <span>Set aside when you marked the thread read. {agent} was told not to wait.</span>;
    if (state === 'replaced') return <span>{agent} replaced this to-do.</span>;
    if (state === 'archived') return <span>Closed when the thread was archived.</span>;
    return null;
  })();

  const icon =
    state === 'done' || state === 'seen' || state === 'pending' ? 'checkCircle' : state === 'cant' ? 'minus' : state === 'set-aside' ? 'clock' : 'checkCircle';

  return (
    <div
      className="ib-todo"
      role="group"
      aria-label={`To do: ${action.prompt}`}
      data-action-card={action.key}
      data-action-state={state}
    >
      <div className="ib-todo-eye">
        <Icon name="todo" />
        <span>
          To do{total > 1 ? ` ${number} of ${total}` : ''} · something only you can do
        </span>
        {pill && <span className={pill.className}>{pill.label}</span>}
      </div>
      <h3 className="ib-todo-do">{action.prompt}</h3>
      {open && action.context && <p className="ib-todo-why">{action.context}</p>}
      {open && (facts.where_url || facts.where || facts.run) && (
        <div className="ib-todo-where">
          <span className="ib-todo-logo" aria-hidden="true">
            <Icon name={facts.run ? 'terminal' : facts.where_url ? 'external' : 'folder'} />
          </span>
          <span className="ib-todo-wt">
            <b>{facts.where ?? (facts.run ? 'In your terminal' : '')}</b>
            {facts.run ? (
              <code className="ib-todo-cmd">{facts.run}</code>
            ) : facts.where_url ? (
              <span className="ib-todo-host">{hostOf(facts.where_url)}</span>
            ) : null}
          </span>
          {facts.run ? (
            <button type="button" className="ib-btn ib-sm" data-action-copy="" onClick={() => void copy()} aria-label={`Copy ${facts.run}`}>
              <Icon name={copied === 'ok' ? 'check' : 'copy'} />
              {copied === 'ok' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
            </button>
          ) : facts.where_url ? (
            <a className="ib-btn ib-sm" href={facts.where_url} target="_blank" rel="noopener noreferrer" data-action-open="">
              Open {facts.where ?? ''}
              <Icon name="external" />
            </a>
          ) : null}
        </div>
      )}
      {open && facts.watching && (
        <p className="ib-todo-watch" data-action-watching="">
          <Icon name="eye" />
          <span>
            {agent} is watching: {facts.watching}
          </span>
        </p>
      )}
      {!open && settled && (
        <p className="ib-todo-settled" data-action-settled="">
          <Icon name={icon} />
          {settled}
        </p>
      )}
      {open && !readOnly && (composing ? (
        <div className="ib-todo-compose">
          <label htmlFor={noteId}>{composing === 'cant' ? `Why can't you? ${agent} gets this word for word.` : `A note for ${agent} (optional)`}</label>
          <textarea
            id={noteId}
            ref={areaRef}
            className="ib-todo-note"
            value={text}
            rows={2}
            maxLength={INBOX_ACTION_NOTE_MAX}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setComposing(null);
              }
            }}
          />
          <div className="ib-todo-foot">
            {composing === 'cant' ? (
              <button
                type="button"
                className="ib-btn ib-pri"
                data-action-cant-send=""
                disabled={busy || text.trim() === ''}
                onClick={() => void mark({ outcome: 'cant', note: text.trim() })}
              >
                Send “Can't do it”
              </button>
            ) : (
              <button type="button" className="ib-btn ib-pri" data-action-done="" disabled={busy} onClick={() => void mark({ outcome: 'done', note: text.trim() || null })}>
                <Icon name="check" />
                Done
              </button>
            )}
            <button type="button" className="ib-btn ib-ghost" onClick={() => setComposing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="ib-todo-foot">
          <button type="button" className="ib-btn ib-pri" data-action-done="" disabled={busy} onClick={() => void mark({ outcome: 'done' })}>
            <Icon name="check" />
            Done
          </button>
          <button type="button" className="ib-btn" data-action-cant="" disabled={busy} onClick={() => setComposing('cant')}>
            Can't do it…
          </button>
          <button type="button" className="ib-btn ib-ghost" data-action-note="" disabled={busy} onClick={() => setComposing('note')}>
            Add note
          </button>
          <span className="ib-todo-hint" data-action-hint="">Done goes to {agent} after 10 s</span>
        </div>
      ))}
    </div>
  );
}
