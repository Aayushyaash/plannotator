/**
 * One event stream for every Inbox tab of an origin.
 *
 * Each Inbox tab used to open its own EventSource, which holds one HTTP/1.1
 * connection for the tab's life. Chrome allows six connections per host, so
 * a seventh Inbox tab (and anything else on that origin) stalled. Now the
 * tabs of one origin elect a leader with a Web Lock (`EVENTS_LOCK`, held for
 * as long as the tab leads): the leader opens the stream and passes every
 * frame on over `BroadcastChannel(EVENTS_CHANNEL)`; the others, followers,
 * only listen. Every tab still gets every frame and runs its own handlers
 * (list reads, notifications with their claims, the sound with its lock), so
 * nothing above this module changes.
 *
 * Handover. When the leader closes, crashes or navigates, the browser frees
 * its lock and the next tab in the lock's queue becomes leader. It opens the
 * stream at the highest seq it has seen (the server replays every line after
 * it), so no record is missed; each tab drops a record whose seq it already
 * passed, so none is handled twice. A tab the browser freezes (`freeze`, or a
 * page entering the back/forward cache) steps down first and queues again as
 * it resumes, so a frozen tab never holds the stream for the others.
 *
 * Presence. The server counts a window for `notify_reach` while it holds a
 * stream; a follower holds none, so it reports `served_by` (the leader's
 * window id, `inboxEventsServedBy`) on every report, and the server counts it
 * while that leader is known (packages/server/inbox-windows.ts). Each tab
 * holds a lock of its own (`WINDOW_LOCK_PREFIX` + its id) for its life; the
 * leader queues for each follower's lock, which the browser grants when that
 * tab is gone (closed or crashed), and tells the server (`gone`). A tab also
 * says so itself at pagehide (a beacon).
 *
 * Where Web Locks or BroadcastChannel is missing (an older browser, an
 * insecure context) `subscribeInboxEvents` opens this tab's own stream, as
 * before. Locks and channels are per origin, so `localhost:<port>` and the
 * tailnet address never share (and a tab left on an old port has its own).
 */

import type { InboxEventFrame, InboxEventHandlers, InboxEventWindow } from './api';

/** The Web Lock the leader holds while it holds the stream. */
export const EVENTS_LOCK = 'plannotator-inbox-events';
/** The channel the leader passes frames on. */
export const EVENTS_CHANNEL = 'plannotator-inbox-events';
/** Each tab's own lock, held for its life; its release tells the leader the tab is gone. */
export const WINDOW_LOCK_PREFIX = 'plannotator-inbox-window:';
/** Frames a tab keeps from the channel before it subscribes (its first list read): beyond this it reads the list again anyway. */
export const EARLY_FRAMES_MAX = 5000;

/** What travels on the channel. `v` lets a later shape be ignored by an older tab. */
export type SharedEventsMessage =
  | { v: 1; type: 'frame'; leader: string; frame: InboxEventFrame }
  /**
   * A tab became leader (`to` absent), or answers one tab's join (`to` its id).
   * `from`: the seq its stream started after; a tab that has seen less fetches the lines between.
   */
  | { v: 1; type: 'leader'; window: string; from: number; to?: string }
  /** A follower is here (or wants to know the leader): the leader watches its lock and answers. */
  | { v: 1; type: 'join'; window: string };

interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown> | unknown): Promise<unknown>;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** What the module needs from the page; tests pass fakes. */
export interface SharedEventsEnv {
  locks: LockManagerLike;
  channel: (name: string) => ChannelLike;
  /** Open this tab's own stream (api.ts `openInboxEventFrames`). */
  open: (cursor: number, onFrame: (frame: InboxEventFrame) => void, win: InboxEventWindow) => () => void;
  /** One frame to the handlers (api.ts `dispatchInboxFrame`). */
  dispatch: (frame: InboxEventFrame, handlers: InboxEventHandlers) => void;
  /** The lines after `cursor` up to now, as frames, from a request that ends (`once=1`): a tab's catch-up. */
  catchUp: (cursor: number) => Promise<InboxEventFrame[]>;
  /** Tell the server a window is gone (`unloading`: from pagehide, where only a beacon is sure to leave). */
  sendGone: (windowId: string, unloading: boolean) => void;
  /** Where `freeze`, `resume` (document) and `pagehide`, `pageshow` (window) arrive; null in tests that drive them. */
  lifecycle: { document: EventTarget; window: EventTarget } | null;
}

export function sharedInboxEventsSupported(): boolean {
  try {
    return (
      typeof BroadcastChannel === 'function' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.locks?.request === 'function' &&
      typeof EventSource === 'function'
    );
  } catch {
    return false;
  }
}

/** The page's own early channel (`prepareInboxEvents`) and what reached it before the subscription. */
let early: { channel: ChannelLike; frames: unknown[] } | null = null;
/** The live subscription, for `inboxEventsServedBy`. */
let active: { servedBy: () => string | null } | null = null;

/**
 * Start listening on the channel before the first list read, so a frame the
 * leader passes on between that read and the subscription is not lost
 * (`subscribeInboxEvents` keeps the ones past the read's cursor).
 */
export function prepareInboxEvents(channel: (name: string) => ChannelLike = defaultChannel): void {
  if (early || !sharedInboxEventsSupported()) return;
  const frames: unknown[] = [];
  const opened = channel(EVENTS_CHANNEL);
  opened.onmessage = (event) => {
    if (frames.length < EARLY_FRAMES_MAX) frames.push(event.data);
  };
  early = { channel: opened, frames };
}

/** The leader whose stream serves this tab, for the window's report (`served_by`); null when this tab leads or knows none. */
export function inboxEventsServedBy(): string | null {
  return active?.servedBy() ?? null;
}

function defaultChannel(name: string): ChannelLike {
  return new BroadcastChannel(name) as unknown as ChannelLike;
}

function defaultSendGone(windowId: string, unloading: boolean): void {
  const body = JSON.stringify({ window: windowId, gone: true });
  try {
    if (unloading && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon('/api/inbox/window', new Blob([body], { type: 'application/json' }))) return;
    }
  } catch {
    // Fall through to fetch.
  }
  void fetch('/api/inbox/window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

/** Read an event-stream body into its named frames. */
export function parseEventStreamText(text: string): InboxEventFrame[] {
  const frames: InboxEventFrame[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let name = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length === 0) continue;
    if ((INBOX_EVENT_FRAME_NAMES as readonly string[]).includes(name)) frames.push({ name: name as InboxEventFrame['name'], data: data.join('\n'), id });
  }
  return frames;
}
const INBOX_EVENT_FRAME_NAMES = ['hello', 'record', 'status', 'reach', 'deliveries', 'drafts'] as const;

async function defaultCatchUp(cursor: number): Promise<InboxEventFrame[]> {
  const res = await fetch(`/api/inbox/events?cursor=${cursor}&once=1`, { headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`catch-up: ${res.status}`);
  return parseEventStreamText(await res.text());
}

/** The page's own pieces, with the stream and the dispatcher from api.ts. */
export function browserSharedEventsEnv(pieces: Pick<SharedEventsEnv, 'open' | 'dispatch'>): SharedEventsEnv {
  return {
    locks: navigator.locks as unknown as LockManagerLike,
    channel: defaultChannel,
    catchUp: defaultCatchUp,
    sendGone: defaultSendGone,
    lifecycle: { document, window },
    ...pieces,
  };
}

type Via = 'stream' | 'channel' | 'catch-up';

/**
 * A test's log of what this tab did (`window.__plannotatorInboxEventLog`, an
 * array a browser proof puts there before the page's own code): the cursor it
 * subscribed at, each record it handled (and how it came), when it led and
 * stopped leading. Nothing is logged without that array.
 */
function trace(entry: Record<string, unknown>): void {
  const log = (globalThis as { __plannotatorInboxEventLog?: unknown }).__plannotatorInboxEventLog;
  if (Array.isArray(log)) log.push({ ...entry, at: Date.now() });
}

function recordSeq(frame: InboxEventFrame): number | null {
  if (frame.name !== 'record') return null;
  const fromId = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
  if (fromId !== null && Number.isSafeInteger(fromId)) return fromId;
  try {
    const seq = (JSON.parse(frame.data) as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : null;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is SharedEventsMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || typeof m.type !== 'string') return false;
  if (m.type === 'frame') {
    const f = m.frame as Record<string, unknown> | null;
    return typeof m.leader === 'string' && !!f && typeof f.name === 'string' && typeof f.data === 'string' && (f.id === null || typeof f.id === 'string');
  }
  if (m.type === 'leader') {
    return typeof m.window === 'string' && typeof m.from === 'number' && Number.isSafeInteger(m.from) && (m.to === undefined || typeof m.to === 'string');
  }
  if (m.type === 'join') return typeof m.window === 'string';
  return false;
}

/**
 * Subscribe this tab through the shared stream: it leads when it holds the
 * lock, follows otherwise. Answers the unsubscribe.
 */
export function subscribeSharedInboxEvents(
  cursor: number,
  handlers: InboxEventHandlers,
  win: InboxEventWindow,
  env: SharedEventsEnv,
): () => void {
  let lastSeq = cursor;
  let leader: string | null = null;
  let leading = false;
  let stopped = false;
  /** Frozen, or in the back/forward cache: not a candidate, not the leader. */
  let suspended = false;
  let closeStream: (() => void) | null = null;
  let releaseLeader: (() => void) | null = null;
  let queued: AbortController | null = null;
  let releaseWindowLock: (() => void) | null = null;
  /** The seq this tab's stream started after, while it leads (`from` in its announcements). */
  let ledFrom = 0;
  const watched = new Map<string, AbortController>();
  /** Fetching what this tab missed: frames that arrive meanwhile wait, so records stay in order. */
  let catching = false;
  /** A catch-up failed (the Inbox restarting): try again at the next hello. */
  let behind = false;
  let held: { frame: InboxEventFrame; via: Via }[] = [];

  let channel: ChannelLike;
  let backlog: unknown[] = [];
  if (early && env.channel === defaultChannel) {
    channel = early.channel;
    backlog = early.frames;
    early = null;
  } else {
    channel = env.channel(EVENTS_CHANNEL);
  }
  const post = (message: SharedEventsMessage) => {
    try {
      channel.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  };

  /** One frame to this tab's handlers, a record once (by seq); held while a catch-up runs. */
  const deliver = (frame: InboxEventFrame, via: Via) => {
    if (stopped) return;
    if (catching && via !== 'catch-up') {
      held.push({ frame, via });
      return;
    }
    if (frame.name === 'hello' && behind && !leading) void catchUp();
    const seq = recordSeq(frame);
    if (seq !== null) {
      if (seq <= lastSeq) return;
      lastSeq = seq;
      trace({ type: 'record', seq, via });
    }
    env.dispatch(frame, handlers);
  };

  /** Fetch the lines after this tab's last seq (it slept, or its leader started past it), then what waited. */
  const catchUp = async (): Promise<void> => {
    if (catching || stopped) return;
    catching = true;
    behind = false;
    try {
      const frames = await env.catchUp(lastSeq);
      for (const frame of frames) if (frame.name === 'record') deliver(frame, 'catch-up');
    } catch {
      behind = true;
    } finally {
      catching = false;
      const waiting = held;
      held = [];
      for (const item of waiting) deliver(item.frame, item.via);
    }
  };

  /**
   * A new leader serves this tab: fetch the lines between this tab's last seq
   * and now first (the new leader's stream may have started past them: this
   * tab slept, or its list read was older than the stream), holding the
   * leader's frames until then; and report again, so the server counts this
   * tab under that leader.
   */
  const setLeader = (id: string | null): boolean => {
    if (id === leader) return false;
    leader = id;
    if (id !== null && id !== win.id && !stopped) {
      void catchUp();
      handlers.onConnect?.();
    }
    return true;
  };

  const watch = (follower: string) => {
    if (follower === win.id || watched.has(follower)) return;
    const abort = new AbortController();
    watched.set(follower, abort);
    env.locks
      .request(WINDOW_LOCK_PREFIX + follower, { signal: abort.signal }, () => {
        // Granted: that tab released its lock, so it is gone (closed, crashed, navigated).
        watched.delete(follower);
        if (leading && !abort.signal.aborted) env.sendGone(follower, false);
      })
      .catch(() => {
        watched.delete(follower);
      });
  };
  const unwatchAll = () => {
    for (const abort of watched.values()) abort.abort();
    watched.clear();
  };

  const lead = () => {
    leading = true;
    leader = win.id;
    ledFrom = lastSeq;
    trace({ type: 'lead', from: ledFrom });
    post({ v: 1, type: 'leader', window: win.id, from: ledFrom });
    closeStream = env.open(lastSeq, (frame) => {
      if (!leading) return;
      post({ v: 1, type: 'frame', leader: win.id, frame });
      deliver(frame, 'stream');
    }, win);
  };

  const stepDown = () => {
    if (leading) {
      leading = false;
      trace({ type: 'step-down' });
      closeStream?.();
      closeStream = null;
      unwatchAll();
      leader = null;
    }
    releaseLeader?.();
    releaseLeader = null;
  };

  const queueForLeader = () => {
    if (stopped || suspended || queued || leading) return;
    const abort = new AbortController();
    queued = abort;
    env.locks
      .request(EVENTS_LOCK, { signal: abort.signal }, () => {
        if (queued === abort) queued = null;
        if (stopped || suspended || abort.signal.aborted) return undefined;
        lead();
        return new Promise<void>((release) => {
          releaseLeader = release;
        });
      })
      .catch(() => {
        if (queued === abort) queued = null;
      });
  };

  const onMessage = (data: unknown) => {
    if (stopped || !isMessage(data)) return;
    if (data.type === 'frame') {
      if (data.leader !== win.id && !leading) setLeader(data.leader);
      deliver(data.frame, 'channel');
      return;
    }
    if (data.type === 'leader') {
      if (data.window === win.id || leading) return;
      setLeader(data.window);
      // A new leader's announcement: tell it this tab is here (it watches this tab's lock and answers this tab only).
      if (data.to === undefined) post({ v: 1, type: 'join', window: win.id });
      return;
    }
    if (data.type === 'join') {
      if (!leading || data.window === win.id) return;
      watch(data.window);
      post({ v: 1, type: 'leader', window: win.id, from: ledFrom, to: data.window });
    }
  };
  trace({ type: 'subscribe', cursor, window: win.id });
  channel.onmessage = (event) => onMessage(event.data);
  for (const data of backlog) onMessage(data);
  backlog = [];

  // This tab's own lock first (the leader watches it), then join and queue for the stream.
  void env.locks
    .request(WINDOW_LOCK_PREFIX + win.id, {}, () => {
      if (stopped) return undefined;
      return new Promise<void>((release) => {
        releaseWindowLock = release;
        if (stopped) {
          release();
          return;
        }
        post({ v: 1, type: 'join', window: win.id });
        queueForLeader();
      });
    })
    .catch(() => {
      // No lock for this tab: it can still lead and follow; a crash is then seen by the server's grace only.
      if (!stopped) {
        post({ v: 1, type: 'join', window: win.id });
        queueForLeader();
      }
    });

  const suspend = () => {
    if (suspended) return;
    suspended = true;
    stepDown();
    queued?.abort();
    queued = null;
  };
  const wake = () => {
    if (!suspended || stopped) return;
    suspended = false;
    leader = null;
    post({ v: 1, type: 'join', window: win.id });
    queueForLeader();
    // Whatever the leader passed on while this tab slept may be gone: fetch from its last seq.
    void catchUp();
  };
  const onFreeze = () => suspend();
  const onResume = () => wake();
  const onPageHide = (event: Event) => {
    // Leaving for good, or for the back/forward cache: either way this tab stops counting now.
    env.sendGone(win.id, true);
    if ((event as PageTransitionEvent).persisted) suspend();
    else stepDown();
  };
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    wake();
    // The server heard `gone` at pagehide: count this tab again.
    handlers.onConnect?.();
  };
  env.lifecycle?.document.addEventListener('freeze', onFreeze);
  env.lifecycle?.document.addEventListener('resume', onResume);
  env.lifecycle?.window.addEventListener('pagehide', onPageHide);
  env.lifecycle?.window.addEventListener('pageshow', onPageShow);

  const self = { servedBy: () => (leading ? null : leader) };
  active = self;

  return () => {
    if (stopped) return;
    stopped = true;
    stepDown();
    queued?.abort();
    queued = null;
    releaseWindowLock?.();
    releaseWindowLock = null;
    env.lifecycle?.document.removeEventListener('freeze', onFreeze);
    env.lifecycle?.document.removeEventListener('resume', onResume);
    env.lifecycle?.window.removeEventListener('pagehide', onPageHide);
    env.lifecycle?.window.removeEventListener('pageshow', onPageShow);
    channel.onmessage = null;
    channel.close();
    if (active === self) active = null;
  };
}
