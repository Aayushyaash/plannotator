/**
 * The thread's place while its read has not landed. Before this the right
 * side was blank: a read that failed once (a dropped connection, a 5xx) left
 * it blank until some agent wrote anywhere in the Inbox, which re-reads the
 * open thread. Now the read is tried again (App.tsx THREAD_READ_RETRY_MS) and
 * this says what is happening. The "Opening" line shows only after a beat
 * (inbox.css `.ib-pwait-line`), so a read that lands at once flashes nothing.
 */
export function ThreadWait(props: {
  /** Why the thread is not on screen yet; null while its first read is on its way. */
  load: { state: 'failed' | 'missing'; error: string } | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { load } = props;
  return (
    <div className="ib-pane ib-pwait" data-thread-wait={load?.state ?? 'loading'} aria-busy={load?.state !== 'missing'}>
      <div className={`ib-pwait-line${load ? ' ib-pwait-now' : ''}`} role="status">
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
