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
 * next opens the thread, or at once when the Inbox says a draft changed
 * (`reload`, on `event: drafts`).
 *
 * A Send waits for the saves in flight (`settle`) and names the `updated_at`
 * its words were saved as, so the server clears only that draft. Each thread
 * has a generation: `sent` and `discard` raise it, and a save queued before
 * then does nothing when its turn comes, so a slow Send never brings the
 * words back as a draft.
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
  /** Per thread: raised by a Send and by Discard; a save queued under an older one does nothing. */
  const generations = useRef(new Map<string, number>());
  const generationOf = (target: string) => generations.current.get(target) ?? 0;
  /** The words the last save queued here carries (or the draft read): the page's last save names them (`base_body`). */
  const lastWords = useRef<string | null>(null);

  const write = useCallback((target: string, text: string) => {
    unsaved += 1;
    const generation = generationOf(target);
    if (target === current.current) lastWords.current = text;
    chain.current = chain.current.then(async () => {
      try {
        // Sent or discarded since this save was queued: the words must not come back.
        if (generation !== generationOf(target)) return;
        let answer: { draft: InboxReplyDraft | null };
        try {
          answer = await inboxApi.saveReplyDraft(target, text, target === current.current ? base.current : await latestBase(target));
        } catch (cause) {
          if (!(cause instanceof InboxApiError) || cause.code !== 'draft_conflict') throw cause;
          const latest = await latestBase(target);
          if (generation !== generationOf(target)) return;
          // Another window saved since: these words, typed here now, go over its.
          answer = await inboxApi.saveReplyDraft(target, text, latest);
        }
        if (generation !== generationOf(target)) return;
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
        lastWords.current = draft?.body ?? null;
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
        // `base` may be a step behind a save still on its way; `base_body` names the words that save carries.
        body: JSON.stringify({
          body: next.text,
          base: base.current,
          ...(lastWords.current !== null ? { base_body: lastWords.current } : {}),
          ...(session ? { serverSession: session } : {}),
        }),
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

  const bump = (target: string) => generations.current.set(target, generationOf(target) + 1);

  /** Discard: the draft goes, here and on the server. */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const target = current.current;
    bump(target);
    lastWords.current = null;
    base.current = null;
    setState({ loadedFor: target, draft: null });
    chain.current = chain.current.then(() => inboxApi.discardReplyDraft(target).then(() => undefined, () => undefined));
  }, []);

  /** The Send carried the words (the server deleted the draft with `clear_draft`): saves still queued do nothing. */
  const sent = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    bump(current.current);
    lastWords.current = null;
    base.current = null;
    setState({ loadedFor: current.current, draft: null });
  }, []);

  /**
   * Before a Send: the words waiting for the pause in typing are saved now, and
   * every save in flight is answered. Resolves with the `updated_at` the box's
   * words were saved as (null when no draft holds them), which the Send names
   * in `clear_draft`.
   */
  const settle = useCallback(async (): Promise<string | null> => {
    flush();
    await chain.current;
    return base.current;
  }, [flush]);

  /**
   * Read the thread's draft again (another window saved or discarded it, or the
   * foot's Send wants the words as they are now). Leaves the words being typed
   * here alone. Answers the draft (null: none), or undefined when it was not
   * read (a save waits, the thread changed, the read failed).
   */
  const reload = useCallback(async (): Promise<InboxReplyDraft | null | undefined> => {
    const target = current.current;
    await chain.current;
    if (target !== current.current || pending.current) return undefined;
    try {
      const draft = (await inboxApi.replyDraft(target)).draft ?? null;
      if (target !== current.current || pending.current) return draft;
      base.current = draft?.updated_at ?? null;
      lastWords.current = draft?.body ?? null;
      setState({ loadedFor: target, draft });
      return draft;
    } catch {
      return undefined;
    }
  }, []);

  /** A save is waiting for the pause in typing (the words are not on the server yet). */
  const waiting = useCallback(() => pending.current !== null, []);

  return { ...state, save, flush, discard, sent, waiting, settle, reload };
}

async function latestBase(threadId: string): Promise<string | null> {
  try {
    return (await inboxApi.replyDraft(threadId)).draft?.updated_at ?? null;
  } catch {
    return null;
  }
}
