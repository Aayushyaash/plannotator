/**
 * The reply box's words, kept per thread as a server draft (approval
 * "inbox-reply-drafts"): saved while the person types (debounced), read back
 * when the thread opens, so they survive leaving the thread, a reload and a
 * restart. Discard drops the draft; the Send that carries the words clears
 * it (the server deletes it on `clear_draft`).
 *
 * Saves run one at a time with the `updated_at` last read as `base`. Another
 * window's newer save answers `409 draft_conflict`: the window being typed in
 * reads the newer `updated_at` and saves its own words over it (the person is
 * typing here now), and the other window picks the newer words up when it
 * next opens the thread.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import { inboxApi, InboxApiError, pageServerSession } from './api';

/** How long typing pauses before the words are saved. */
export const REPLY_DRAFT_SAVE_MS = 500;

export interface ReplyDraftState {
  /** The thread the draft below was read for (null until the first read answers). */
  loadedFor: string | null;
  draft: InboxReplyDraft | null;
}

/** Whether a save is waiting or in flight anywhere on the page (the restart guard reads it). */
let unsaved = 0;
export function replyDraftUnsaved(): boolean {
  return unsaved > 0;
}

export function useReplyDraft(threadId: string) {
  const [state, setState] = useState<ReplyDraftState>({ loadedFor: null, draft: null });
  const base = useRef<string | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<{ threadId: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(threadId);
  current.current = threadId;

  const write = useCallback((target: string, text: string) => {
    unsaved += 1;
    chain.current = chain.current.then(async () => {
      try {
        let answer: { draft: InboxReplyDraft | null };
        try {
          answer = await inboxApi.saveReplyDraft(target, text, target === current.current ? base.current : await latestBase(target));
        } catch (cause) {
          if (!(cause instanceof InboxApiError) || cause.code !== 'draft_conflict') throw cause;
          // Another window saved since: these words, typed here now, go over its.
          answer = await inboxApi.saveReplyDraft(target, text, await latestBase(target));
        }
        if (target === current.current) {
          base.current = answer.draft?.updated_at ?? null;
          setState({ loadedFor: target, draft: answer.draft ?? null });
        }
      } catch {
        // Kept in the box; the next pause in typing tries again.
      } finally {
        unsaved -= 1;
      }
    });
  }, []);

  /** Save what waits now (leaving the thread, the page going away). */
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) write(next.threadId, next.text);
  }, [write]);

  // The thread's draft, read when it opens; what waited for the last thread is saved first.
  useEffect(() => {
    let live = true;
    base.current = null;
    setState({ loadedFor: null, draft: null });
    void chain.current.then(async () => {
      try {
        // An older Inbox answers 404 (caught below): no draft.
        const draft = (await inboxApi.replyDraft(threadId)).draft ?? null;
        if (!live) return;
        base.current = draft?.updated_at ?? null;
        setState({ loadedFor: threadId, draft });
      } catch {
        if (live) setState({ loadedFor: threadId, draft: null });
      }
    });
    return () => {
      live = false;
      flush();
    };
  }, [threadId, flush]);

  // A reload or a closed tab while a save waits: sent as the page goes (keepalive).
  useEffect(() => {
    const onHide = () => {
      const next = pending.current;
      if (!next) return;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      const session = pageServerSession();
      void fetch(`/api/inbox/threads/${encodeURIComponent(next.threadId)}/draft`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: next.text, base: base.current, ...(session ? { serverSession: session } : {}) }),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  /** The words changed: saved after a pause in typing. */
  const save = useCallback(
    (text: string) => {
      pending.current = { threadId: current.current, text };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, REPLY_DRAFT_SAVE_MS);
    },
    [flush],
  );

  /** Discard: the draft goes, here and on the server. */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const target = current.current;
    base.current = null;
    setState({ loadedFor: target, draft: null });
    chain.current = chain.current.then(() => inboxApi.discardReplyDraft(target).then(() => undefined, () => undefined));
  }, []);

  /** The Send carried the words (the server deleted the draft with `clear_draft`). */
  const sent = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    base.current = null;
    setState({ loadedFor: current.current, draft: null });
  }, []);

  /** A save is waiting for the pause in typing (the words are not on the server yet). */
  const waiting = useCallback(() => pending.current !== null, []);

  return { ...state, save, flush, discard, sent, waiting };
}

async function latestBase(threadId: string): Promise<string | null> {
  try {
    return (await inboxApi.replyDraft(threadId)).draft?.updated_at ?? null;
  } catch {
    return null;
  }
}
