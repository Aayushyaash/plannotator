import { useCallback, useEffect, useRef } from 'react';
import { noteServerSessionMismatch, withServerSession } from '@plannotator/ui/utils/serverSession';
import type { VersionInfo } from '@plannotator/ui/hooks/usePlanDiff';

/**
 * How long the open file must stay unchanged before its new text is saved as
 * a version (#2037). An agent often writes a file several times in a row;
 * one version per burst keeps the history readable and the diff on the
 * agent's whole edit.
 */
export const LIVE_VERSION_SETTLE_MS = 750;

export interface LiveAnnotateVersion {
  previousPlan: string | null;
  versionInfo: VersionInfo;
}

interface SaveAnswer {
  ok?: boolean;
  saved?: boolean;
  previousPlan?: string | null;
  versionInfo?: VersionInfo;
}

/**
 * Saves the session's own file as a version when it changed on disk and then
 * held still for {@link LIVE_VERSION_SETTLE_MS} (`POST /api/plan/versions`,
 * see packages/shared/annotate-live-version.ts). `schedule(hash)` is called
 * with the source hash of the text the editor now shows; the server saves the
 * file only while its bytes still have that hash. `onSaved` runs only for a
 * NEW version, and only for the latest request, so a slow answer never
 * replaces a newer one. Failures are silent: the text is already on screen,
 * and the next open saves the version anyway.
 */
export function useLiveAnnotateVersion({
  enabled,
  onSaved,
  settleMs = LIVE_VERSION_SETTLE_MS,
  fetchImpl,
}: {
  enabled: boolean;
  onSaved: (version: LiveAnnotateVersion) => void;
  settleMs?: number;
  fetchImpl?: typeof fetch;
}): { schedule: (hash: string) => void; cancel: () => void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const onSavedRef = useRef(onSaved);
  const enabledRef = useRef(enabled);
  const fetchRef = useRef(fetchImpl);
  useEffect(() => {
    onSavedRef.current = onSaved;
    enabledRef.current = enabled;
    fetchRef.current = fetchImpl;
  });

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    seqRef.current += 1;
  }, []);

  const save = useCallback(async (hash: string, seq: number) => {
    const doFetch = fetchRef.current ?? fetch;
    let res: Response;
    try {
      res = await doFetch('/api/plan/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withServerSession({ hash })),
      });
    } catch {
      return;
    }
    if (await noteServerSessionMismatch(res)) return;
    if (!res.ok) return;
    let answer: SaveAnswer;
    try {
      answer = (await res.json()) as SaveAnswer;
    } catch {
      return;
    }
    if (seq !== seqRef.current || !enabledRef.current) return;
    if (answer.ok !== true || answer.saved !== true || !answer.versionInfo) return;
    onSavedRef.current({ previousPlan: answer.previousPlan ?? null, versionInfo: answer.versionInfo });
  }, []);

  const schedule = useCallback((hash: string) => {
    if (!enabledRef.current || !hash) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const seq = ++seqRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(hash, seq);
    }, settleMs);
  }, [save, settleMs]);

  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  return { schedule, cancel };
}
