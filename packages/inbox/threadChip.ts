/**
 * The thread's name as a chip, unless the subject already starts with it
 * (agents often begin the subject with the thread's name, and a row then said
 * it twice). Compared the way threads are matched (`inboxThreadNameKey`), and
 * only when the name ends where the subject's words do: the subject ends
 * there, or goes on with a space, or with ":", "-", "–" or "—" and a space.
 * So `search` still shows beside "Searchable…", `v2` beside "v2.1 release"
 * and `auth` beside "auth-service down". Shared by the list's rows and
 * search's results.
 */

import { inboxThreadNameKey } from '@plannotator/core/inbox-types';

export function threadChipName(threadName: string | null | undefined, subject: string): string | null {
  if (!threadName) return null;
  const name = inboxThreadNameKey(threadName);
  const words = inboxThreadNameKey(subject);
  if (name && words.startsWith(name) && /^(?:$|\s|[:\-–—]\s)/u.test(words.slice(name.length))) return null;
  return threadName;
}
