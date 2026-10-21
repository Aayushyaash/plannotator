import { useLayoutEffect, useRef } from 'react';

/**
 * The thread's place while its read has not landed. Before this the right
 * side was blank: a read that failed once (a dropped connection, a 5xx) left
 * it blank until some agent wrote anywhere in the Inbox, which re-reads the
 * open thread. Now the read is tried again (App.tsx THREAD_READ_RETRY_MS) and
 * this says what is happening. Nothing shows for the first 600 ms from the
 * open, whatever the state (inbox.css `.ib-pwait-line`), so a read that lands
 * at once, or fails and then lands within that time, flashes nothing. App
 * keys it by thread, so the delay counts from each thread's open.
 */
export function ThreadWait(props: {
  /** Why the thread is not on screen yet; null while its read is on its way. */
  load: { state: 'failed' | 'missing'; error: string } | null;
  onRetry: () => void;
  onClose: () => void;
  /** Called as it gives way (the thread landed, or it closed) while focus is inside it. */
  onFocusLeaving: () => void;
}) {
  const { load } = props;
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(props.onFocusLeaving);
  leaving.current = props.onFocusLeaving;
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el && typeof document !== 'undefined' && el.contains(document.activeElement)) leaving.current();
    };
  }, []);
  return (
    <div ref={ref} className="ib-pane ib-pwait" data-thread-wait={load?.state ?? 'loading'} aria-busy={load === null}>
      <div className="ib-pwait-line" role="status">
        {load?.state === 'missing' ? (
          <>
            <span>This thread is not in the Inbox. It may have been deleted.</span>
            <button type="button" className="ib-btn" onClick={props.onClose} data-thread-wait-close="">
              Close
            </button>
          </>
        ) : load?.state === 'failed' ? (
          <>
            <span>Couldn't load this thread ({load.error}). Trying again…</span>
            <button type="button" className="ib-btn" onClick={props.onRetry} data-thread-wait-retry="">
              Try again
            </button>
          </>
        ) : (
          <span>Opening the thread…</span>
        )}
      </div>
    </div>
  );
}
