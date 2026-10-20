/**
 * Plannotator Inbox: New message (PLAN step 8; owner Q4, "just another button
 * next to reply", built as a try).
 *
 * The live sessions: every agent connection long-polls the bridge for its
 * session (packages/server/inbox.ts, `bridgePoll`), and a poll says where the
 * session works (`project_path`), when it started and whether a turn runs; a
 * `state` event says when that changes. A session is live while it polled
 * within `INBOX_SESSION_LIVE_MS`, or holds a poll open now. Kept in memory
 * only: after an Inbox restart a session is live again at its next poll.
 *
 * A session is in a thread's project when its `project_path` resolves to the
 * project's root (the resolution send_message uses: realpath, then the
 * repository, a linked worktree counting as its main repository), or, for
 * a connection that does not say where it works, when it wrote in that
 * project.
 *
 * The window's two routes (same origin and the page's serverSession, as every
 * window route):
 *   GET  /api/inbox/threads/:id/sessions  the project's live sessions, the
 *        thread's own writers first;
 *   POST /api/inbox/threads/:id/message   `{ session, body, idempotency_key }`:
 *        the person's message, addressed to that session while it is live
 *        (409 `session_not_live` otherwise, nothing written). Its connection
 *        is handed it on its next poll and delivers it like a reply.
 *
 * Replying when the asking session has ended (design record "replying when
 * the asking agent's session has ended", not in this repo): the sessions
 * route also answers whether the session that asked (`?asker=<session>`) is
 * still there (`asker: { session, live }`), with a grace of
 * `INBOX_ASKER_GRACE_MS` so a short gap, or an Inbox that just started and
 * has not heard from its sessions yet, never reads as ended. The reply route
 * (packages/server/inbox.ts) takes `to: { host, session }` and checks it with
 * `replyTarget`, as New message does.
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import { INBOX_TAGS_MAX, type InboxHostSessions, type InboxOpenSession, type InboxProject, type InboxSessionOutdated, type InboxTag, type InboxToolHostId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_SEND_NOW_POLL_FIELD, INBOX_SESSION_LIVE_MS, INBOX_TAGS_POLL_FIELD } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { parseEngine, parseLoadedPlugin, parseSessionFolder, type LoadedPlugin } from "./inbox-restart";

/** One live session as the window reads it. */
export interface InboxLiveSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  /** A turn runs now; null when the connection does not say. */
  busy: boolean | null;
  /** Idle since then; null while busy or when the connection does not say. */
  idle_since: string | null;
  /** It wrote in this thread. */
  wrote_thread: boolean;
  /** Its connection can deliver into a running turn (Send now); false when it does not say. */
  send_now: boolean;
}

/**
 * How the session a person's message goes to is connected now, for the
 * window's line under that message: present while the session's connection
 * polls (live, no grace). `busy` null when the connection does not say.
 */
export interface InboxRecipientConnection {
  busy: boolean | null;
  idle_since: string | null;
  /** Send now can be offered: the connection said it can deliver into a running turn. */
  send_now: boolean;
  /**
   * The session runs an older Plannotator plugin than a restart would load,
   * or one the installed plugin is itself behind (packages/server/inbox-restart.ts);
   * null when it is up to date or the Inbox cannot tell. Additive.
   */
  outdated: InboxSessionOutdated | null;
  /** Claude Code's own version as its poll reported it (`engine`); null when it does not say. Additive. */
  engine: string | null;
  /** The command that starts the same session again in its folder (`cd <folder> && claude --resume <id>`); null when unknown. Additive. */
  restart_command: string | null;
}

interface SeenSession {
  host: string;
  /** The project root its `project_path` resolved to; null when it sent none. */
  root: string | null;
  startedAt: number;
  lastSeen: number;
  /** Polls held open now. */
  holding: number;
  busy: boolean | null;
  idleSince: number | null;
  /** Its poll said it can deliver into a running turn (`send_now`). */
  sendNow: boolean;
  /** Its poll said it understands a reply it was tagged in (`tags`): only then can it be tagged. */
  tags: boolean;
  /** The working folder its poll named (`project_path`), as sent; null when it sent none. */
  cwd: string | null;
  /**
   * Where the session started (`session_folder`, the Claude Code mod's
   * `$.session.root()` as it was at session start): the folder its
   * `claude --resume` runs in. Null when its connection sends none.
   */
  folder: string | null;
  /** What its poll said it loaded (`plugin`); null when it sent none (a connection older than the field). */
  plugin: LoadedPlugin | null;
  /** Claude Code's version (`engine`); null when it sent none. */
  engine: string | null;
}

/**
 * An agent that reads the Inbox through MCP only (approval "inbox-tag-agents",
 * Q2: any MCP agent may be tagged): it is never woken, and sees a tag the next
 * time it reads the thread or waits for a reply.
 */
export interface InboxMcpAgent {
  session: string;
  host: string | null;
  /** The name it gave itself, if any. */
  name: string | null;
  /** Where it last wrote, if it wrote. */
  project_id: string | null;
  /** When it last wrote or called an Inbox tool. */
  last_at: string;
}

/** How long an MCP agent stays on the tag list after it last wrote or called a tool. */
export const INBOX_MCP_AGENT_LISTED_MS = 14 * 24 * 60 * 60 * 1000;
/** The most MCP agents the tag list offers. */
export const INBOX_MCP_AGENTS_MAX = 30;

/**
 * How long the session that asked may go without a poll before the window
 * says it has ended: twice the live window, so a slept laptop or a slow poll
 * does not show the note for a moment.
 */
export const INBOX_ASKER_GRACE_MS = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const finiteMs = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

export function createInboxLiveSessions(options: {
  store: InboxStore;
  serverSession: string;
  resolveRoot: (path: string) => Promise<string>;
  now?: () => number;
  /**
   * Whether a session on `host` that loaded `plugin` (null: its poll sent
   * none) is outdated (packages/server/inbox-restart.ts). Absent: never.
   */
  outdatedOf?: (host: string, plugin: LoadedPlugin | null, folder: string | null) => InboxSessionOutdated | null;
  /** A working folder as the window shows it (the home folder as `~`). */
  displayFolder?: (path: string) => string;
  /** The command that restarts a session as itself, in its folder (shown); null for a host without one. */
  restartCommandOf?: (host: string, folder: string, session: string) => string | null;
}) {
  const { store, serverSession } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const sessions = new Map<string, SeenSession>();
  /**
   * MCP activity per agent session: when a tool call last named it, and the
   * wait_for_reply calls it holds open now. Presence only (a session that
   * asked is not "ended" while it talks to the Inbox); it never makes a
   * session live for New message, which needs a connection that wakes it.
   */
  const mcpSeen = new Map<string, { lastSeen: number; holding: number; host?: string; name?: string }>();
  const mcpEntry = (session: string) => {
    let entry = mcpSeen.get(session);
    if (!entry) {
      entry = { lastSeen: now(), holding: 0 };
      mcpSeen.set(session, entry);
    }
    return entry;
  };
  /** A tool call named this agent session (and, when the call said so, its host and name: the tag list's MCP rows). */
  const seenOverMcp = (session: string, who: { host?: unknown; name?: unknown } = {}) => {
    if (!session) return;
    const entry = mcpEntry(session);
    entry.lastSeen = now();
    if (typeof who.host === "string" && who.host.trim() && who.host.length <= 64) entry.host = who.host.trim();
    if (typeof who.name === "string" && who.name.trim() && who.name.length <= 80) entry.name = who.name.trim();
  };
  /** A wait_for_reply for this session is open: present until it answers. */
  const holdOverMcp = (session: string): (() => void) => {
    const entry = mcpEntry(session);
    entry.holding += 1;
    entry.lastSeen = now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holding = Math.max(0, entry.holding - 1);
      entry.lastSeen = now();
    };
  };
  /**
   * project_path to its project's root. The Inbox passes its shared
   * project-root cache (packages/server/inbox-project-root.ts), which asks
   * git once per folder, so every poll after the first answers from memory
   * and a session agrees with where its sends land (a linked worktree's
   * session is in its main repository's project).
   */
  const rootOf = (path: unknown): Promise<string | null> => {
    if (typeof path !== "string" || !path) return Promise.resolve(null);
    return options.resolveRoot(path).catch(() => null);
  };

  const applyState = (entry: SeenSession, body: Record<string, unknown>, at: number) => {
    if (typeof body.busy !== "boolean") return;
    if (body.busy) {
      entry.busy = true;
      entry.idleSince = null;
    } else {
      entry.idleSince = entry.busy === false && entry.idleSince !== null ? entry.idleSince : (finiteMs(body.idle_since) ?? at);
      entry.busy = false;
    }
  };

  /** A poll arrived: the session is live, and says where it works. Returns the call to make when the poll answers. */
  const pollStarted = async (session: string, host: string, body: Record<string, unknown>): Promise<() => void> => {
    const at = now();
    const root = await rootOf(body.project_path);
    const entry: SeenSession = sessions.get(session) ?? {
      host,
      root,
      startedAt: finiteMs(body.started_at) ?? at,
      lastSeen: at,
      holding: 0,
      busy: null,
      idleSince: null,
      sendNow: false,
      cwd: null,
      folder: null,
      plugin: null,
      engine: null,
      tags: false,
    };
    entry.host = host;
    entry.sendNow = body[INBOX_SEND_NOW_POLL_FIELD] === true;
    entry.tags = body[INBOX_TAGS_POLL_FIELD] === true;
    // What the session loaded (additive poll fields; an older connection sends neither).
    entry.plugin = parseLoadedPlugin(body.plugin);
    entry.engine = parseEngine(body.engine);
    if (typeof body.project_path === "string" && body.project_path) entry.cwd = body.project_path;
    const folder = parseSessionFolder(body.session_folder);
    if (folder) entry.folder = folder;
    if (root !== null) entry.root = root;
    entry.startedAt = finiteMs(body.started_at) ?? entry.startedAt;
    entry.lastSeen = at;
    entry.holding += 1;
    applyState(entry, body, at);
    sessions.set(session, entry);
    return () => {
      entry.holding = Math.max(0, entry.holding - 1);
      entry.lastSeen = now();
    };
  };

  /** A `state` event: a turn started or ended, or whether a Send now reply can go in changed. */
  const stateChanged = (session: string, host: string, body: Record<string, unknown>) => {
    const entry = sessions.get(session);
    if (!entry) return;
    const at = now();
    entry.host = host;
    entry.lastSeen = at;
    applyState(entry, body, at);
    if (typeof body[INBOX_SEND_NOW_POLL_FIELD] === "boolean") entry.sendNow = body[INBOX_SEND_NOW_POLL_FIELD] === true;
  };

  const isLive = (entry: SeenSession) => entry.holding > 0 || now() - entry.lastSeen <= INBOX_SESSION_LIVE_MS;

  /**
   * Whether the session that asked is still there, with the grace above: it
   * holds a poll or an MCP wait_for_reply, or polled or called an MCP tool
   * within `INBOX_ASKER_GRACE_MS`, or this Inbox started less than that long
   * ago (sessions are kept in memory only). The window asks only about a
   * session whose message came through a connection that wakes it
   * (`InboxMessage.wakes`).
   */
  const askerLive = (session: string): boolean => {
    const recent = (entry: { holding: number; lastSeen: number } | undefined) =>
      !!entry && (entry.holding > 0 || now() - entry.lastSeen <= INBOX_ASKER_GRACE_MS);
    if (recent(sessions.get(session)) || recent(mcpSeen.get(session))) return true;
    return now() - startedAt <= INBOX_ASKER_GRACE_MS;
  };

  /**
   * The reply route's `to`: the live session of the thread's project it
   * names (the host, when given, must match), or null when it is not live.
   */
  const replyTarget = (threadId: string, to: unknown): { host: string; session: string } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === session) ?? null;
    if (!target || (host !== undefined && target.host !== host)) return null;
    return { host: target.host, session: target.session };
  };

  /** The live sessions of a thread's project: its writers first (the latest writer first), then by start. */
  const liveFor = (threadId: string): { project: InboxProject; sessions: InboxLiveSession[] } => {
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const project = thread.project;
    const lastWrote = new Map<string, number>();
    thread.messages.forEach((message, index) => {
      if (message.author.kind === "agent" && message.author.session) lastWrote.set(message.author.session, index);
    });
    let wroteInProject: Set<string> | null = null;
    const out: (InboxLiveSession & { order: number; started: number })[] = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      if (entry.root !== null) {
        if (entry.root !== project.root) continue;
      } else {
        wroteInProject ??= new Set(
          store
            .threadsOf(project.id)
            .flatMap((summary) => store.thread(summary.thread_id)?.messages ?? [])
            .flatMap((message) => (message.author.kind === "agent" && message.author.session ? [message.author.session] : [])),
        );
        if (!wroteInProject.has(session)) continue;
      }
      out.push({
        session,
        host: entry.host,
        started_at: iso(entry.startedAt),
        last_seen_at: iso(entry.lastSeen),
        busy: entry.busy,
        idle_since: entry.busy === false && entry.idleSince !== null ? iso(entry.idleSince) : null,
        wrote_thread: lastWrote.has(session),
        send_now: entry.sendNow,
        order: lastWrote.get(session) ?? -1,
        started: entry.startedAt,
      });
    }
    out.sort((a, b) => b.order - a.order || a.started - b.started);
    return { project, sessions: out.map(({ order: _order, started: _started, ...session }) => session) };
  };

  /**
   * Every live session in any project (compose), with the root its
   * `project_path` resolved to (null when its connection sends none).
   */
  const allLive = (): {
    session: string;
    host: string;
    root: string | null;
    startedAt: number;
    lastSeen: number;
    busy: boolean | null;
    idleSince: number | null;
    /** Its connection understands a reply it was tagged in (`tags`). */
    tags: boolean;
    sendNow: boolean;
  }[] => {
    const out = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      out.push({
        session,
        host: entry.host,
        root: entry.root,
        startedAt: entry.startedAt,
        lastSeen: entry.lastSeen,
        busy: entry.busy,
        idleSince: entry.busy === false ? entry.idleSince : null,
        tags: entry.tags,
        sendNow: entry.sendNow,
      });
    }
    return out;
  };

  /**
   * The agents that read the Inbox through MCP only, newest first: every
   * session whose latest message did not come through a waking connection,
   * and every session an MCP tool call named with its host or name, within
   * `INBOX_MCP_AGENT_LISTED_MS`; never a session that polls now (that one is
   * live and woken).
   */
  const mcpAgents = (): InboxMcpAgent[] => {
    const cutoff = now() - INBOX_MCP_AGENT_LISTED_MS;
    const out = new Map<string, InboxMcpAgent & { at: number }>();
    for (const [session, message] of store.latestAgentMessages()) {
      if (message.wakes === true || message.author.kind !== "agent") continue;
      const polling = sessions.get(session);
      if (polling && isLive(polling)) continue;
      const at = Date.parse(message.created_at);
      if (!(at >= cutoff)) continue;
      out.set(session, { session, host: message.author.host ?? null, name: message.author.name ?? null, project_id: message.project_id, last_at: message.created_at, at });
    }
    for (const [session, entry] of mcpSeen) {
      if (entry.lastSeen < cutoff) continue;
      const polling = sessions.get(session);
      if (polling && isLive(polling)) continue;
      const known = out.get(session);
      if (known) {
        if (entry.lastSeen > known.at) Object.assign(known, { at: entry.lastSeen, last_at: iso(entry.lastSeen) });
        known.host ??= entry.host ?? null;
        known.name ??= entry.name ?? null;
        continue;
      }
      // A session that never wrote is listed only when its calls said who it is.
      if (!entry.host && !entry.name) continue;
      out.set(session, { session, host: entry.host ?? null, name: entry.name ?? null, project_id: null, last_at: iso(entry.lastSeen), at: entry.lastSeen });
    }
    return [...out.values()]
      .sort((a, b) => b.at - a.at || a.session.localeCompare(b.session))
      .slice(0, INBOX_MCP_AGENTS_MAX)
      .map(({ at: _at, ...agent }) => agent);
  };

  /**
   * The reply route's `tags` (approval "inbox-tag-agents"): each `{ host?, session }`
   * names a live session whose connection understands tags (woken), or an MCP
   * agent the Inbox knows (not woken), in any project. Refused before anything
   * is written: a live session on an older Plannotator (`tag_needs_update`),
   * a session the Inbox knows under another host than the tag says
   * (`tag_host_mismatch`), and one that is neither (`session_not_live`).
   */
  const tagTargets = (value: unknown): InboxTag[] => {
    if (!Array.isArray(value)) throw new InboxError("validation_error", "tags: a list of { host, session }.", { field: "tags" });
    if (value.length > INBOX_TAGS_MAX) throw new InboxError("validation_error", `tags: at most ${INBOX_TAGS_MAX} sessions.`, { field: "tags" });
    const out: InboxTag[] = [];
    const old: string[] = [];
    const missing: string[] = [];
    const mismatched: string[] = [];
    let agents: InboxMcpAgent[] | null = null;
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new InboxError("validation_error", "tags: each one { host, session }.", { field: "tags" });
      const { host, session, label } = item as Record<string, unknown>;
      if (typeof session !== "string" || !session) throw new InboxError("validation_error", "tags: each one names a session.", { field: "tags" });
      // The readable label rides along (the store checks its shape).
      const labeled = typeof label === "string" ? { label } : {};
      if (host !== undefined && host !== null && typeof host !== "string") throw new InboxError("validation_error", "tags: host a string.", { field: "tags" });
      const entry = sessions.get(session);
      if (entry && isLive(entry) && (host === undefined || host === entry.host)) {
        if (entry.tags) out.push({ host: entry.host, session, ...labeled, wakes: true });
        else old.push(session);
        continue;
      }
      agents ??= mcpAgents();
      const agent = agents.find((candidate) => candidate.session === session && (host === undefined || host === candidate.host));
      if (agent) {
        out.push({ host: agent.host, session, ...(agent.name ? { name: agent.name } : {}), ...labeled, wakes: false });
        continue;
      }
      // Known, but as another agent than the tag names: say that, not "not live".
      const known = (entry && isLive(entry)) || agents.some((candidate) => candidate.session === session);
      if (known) mismatched.push(session);
      else missing.push(session);
    }
    if (old.length > 0) {
      throw new InboxError(
        "tag_needs_update",
        "A session you tagged runs an older Plannotator that can't be tagged: nothing was sent. Update Plannotator there, or remove the tag.",
        { sessions: old },
      );
    }
    if (mismatched.length > 0) {
      throw new InboxError(
        "tag_host_mismatch",
        "A session you tagged is another agent than the tag says: nothing was sent. Remove the tag and pick the session from the list again.",
        { sessions: mismatched },
      );
    }
    if (missing.length > 0) {
      throw new InboxError("session_not_live", "A session you tagged is not live any more: nothing was sent. Remove the tag, or tag another session.", { sessions: missing });
    }
    return out;
  };

  /** How a session is connected now (live, no grace), or null when its connection does not poll. */
  const connectionOf = (session: string): InboxRecipientConnection | null => {
    const entry = sessions.get(session);
    if (!entry || !isLive(entry)) return null;
    return {
      busy: entry.busy,
      idle_since: entry.busy === false && entry.idleSince !== null ? iso(entry.idleSince) : null,
      send_now: entry.sendNow,
      outdated: outdatedOf(entry),
      engine: entry.engine,
      restart_command: restartCommandOf(session, entry),
    };
  };

  /** The folder a restart runs in (shown with ~): where the session started, else where it works now. */
  const folderOf = (entry: SeenSession): string | null => {
    const path = entry.folder ?? entry.cwd;
    return path ? (options.displayFolder?.(path) ?? path) : null;
  };
  const restartCommandOf = (session: string, entry: SeenSession): string | null => {
    const folder = folderOf(entry);
    return folder && options.restartCommandOf ? options.restartCommandOf(entry.host, folder, session) : null;
  };

  const outdatedOf = (entry: SeenSession): InboxSessionOutdated | null => options.outdatedOf?.(entry.host, entry.plugin, entry.folder ?? entry.cwd) ?? null;

  /**
   * The live sessions of the three Plannotator hosts, for Settings → Agents'
   * "Open sessions" row: each with what it loaded and whether a restart (or
   * an update) would bring it up to date. Newest first.
   */
  const hostSessions = (
    extra: (host: InboxToolHostId) => { installed: string | null; update_command: string | null },
  ): Partial<Record<InboxToolHostId, InboxHostSessions>> => {
    const out: Partial<Record<InboxToolHostId, InboxHostSessions>> = {};
    const hosts: readonly InboxToolHostId[] = ["claude-code", "pi", "opencode"];
    for (const [session, entry] of [...sessions].sort((a, b) => b[1].startedAt - a[1].startedAt)) {
      if (!isLive(entry) || !(hosts as readonly string[]).includes(entry.host)) continue;
      const host = entry.host as InboxToolHostId;
      const info = extra(host);
      const group = (out[host] ??= { running: 0, outdated: 0, installed: info.installed, update_command: info.update_command, sessions: [] });
      const outdated = outdatedOf(entry);
      const folder = folderOf(entry);
      const row: InboxOpenSession = {
        session,
        project: entry.root ? basename(entry.root) : entry.cwd ? basename(entry.cwd) : null,
        folder,
        started_at: iso(entry.startedAt),
        busy: entry.busy,
        plugin: entry.plugin?.version ?? null,
        outdated,
        restart_command: restartCommandOf(session, entry),
      };
      group.running += 1;
      if (outdated) group.outdated += 1;
      group.sessions.push(row);
    }
    return out;
  };

  /** Live Claude Code sessions a restart brings up to date: the sidebar's "Reload Claude Code N". */
  const restartCount = (): number => {
    let count = 0;
    for (const entry of sessions.values()) {
      if (entry.host === "claude-code" && isLive(entry) && outdatedOf(entry)?.fix === "restart") count += 1;
    }
    return count;
  };

  /** Whether a session is live now (no grace: compose sends only to a session that polls). */
  const isSessionLive = (session: string): boolean => {
    const entry = sessions.get(session);
    return !!entry && isLive(entry);
  };

  /** `{ host?, session }` naming a live session in any project, or null when it is not live (compose's Send). */
  const composeTarget = (to: unknown): { host: string; session: string; root: string | null } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const entry = sessions.get(session);
    if (!entry || !isLive(entry) || (host !== undefined && entry.host !== host)) return null;
    return { host: entry.host, session, root: entry.root };
  };

  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });

  /** The window's routes; null when the path is not one of them. */
  const route = async (req: Request, path: string): Promise<Response | null> => {
    const sessionsMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/sessions$/.exec(path);
    if (sessionsMatch) {
      if (req.method !== "GET") return answer({ error: "Use GET." }, 405);
      const live = liveFor(sessionsMatch[1]!);
      const asker = new URL(req.url).searchParams.get("asker");
      const recipients = (new URL(req.url).searchParams.get("recipients") ?? "")
        .split(",")
        .map((session) => session.trim())
        .filter((session) => session !== "")
        .slice(0, INBOX_TAGS_MAX);
      return answer({
        serverSession,
        home: homedir(),
        project: live.project,
        sessions: live.sessions,
        // `connection` (additive): how that session is connected now, for the line under the person's message ("Queued", "Sending", Send now).
        ...(asker ? { asker: { session: asker, live: askerLive(asker), connection: connectionOf(asker) } } : {}),
        // `recipients` (additive, "inbox-tag-agents"): how each session a reply tags is connected now, for its own line.
        ...(recipients.length > 0 ? { recipients: Object.fromEntries(recipients.map((session) => [session, connectionOf(session)])) } : {}),
      });
    }
    const sendNowMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/send-now$/.exec(path);
    if (sendNowMatch) {
      if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
      let body: Record<string, unknown> = {};
      try {
        const value = await req.json();
        body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      } catch {
        throw new InboxError("validation_error", "body: expected a JSON object.");
      }
      if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return answer({ message: sendNow(sendNowMatch[1]!, typeof body.session === "string" && body.session ? body.session : null) });
    }
    const messageMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/message$/.exec(path);
    if (!messageMatch) return null;
    if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.session !== "string" || !body.session) {
      throw new InboxError("validation_error", "session: the live session to write to.", { field: "session" });
    }
    const threadId = messageMatch[1]!;
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === body.session) ?? null;
    const result = store.sendNewMessage(threadId, {
      body: body.body,
      idempotency_key: body.idempotency_key,
      to: target ? { host: target.host, session: target.session } : null,
    });
    return answer({ message: result.message, replayed: result.replayed });
  };

  /**
   * Send now: the person's reply or message, delivered at once by its
   * session's connection (into the running turn when one runs). Refused when
   * that session's connection does not poll now or cannot deliver into a
   * running turn (`send_now_unavailable`), or once delivered.
   */
  const sendNow = (messageId: string, session: string | null = null) => {
    const message = store.message(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    // A tagged session's own line (approval "inbox-tag-agents"): its own Send now.
    const tag = session && !store.isOwner(message, session) ? (message.tags?.find((t) => t.session === session) ?? null) : null;
    if (session && !tag && !store.isOwner(message, session)) throw new InboxError("not_addressed", "That session is not one this message goes to.");
    const delivery = tag ? tag.delivery : message.delivery;
    if (delivery) throw new InboxError("already_delivered", "That session already took this.", { delivery });
    const recipient = tag ? { host: tag.host, session: tag.session } : store.recipientOf(message);
    if (!recipient) throw new InboxError("not_addressed", "Only your reply or message to an agent session can be sent now.");
    const connection = connectionOf(recipient.session);
    if (!connection?.send_now) {
      throw new InboxError(
        "send_now_unavailable",
        connection ? "This agent's connection cannot take a message mid-turn; it gets it when its turn ends." : "That session is not connected now; it gets this when it is back.",
      );
    }
    return store.requestDeliverNow(messageId, tag ? tag.session : null);
  };

  return {
    pollStarted,
    stateChanged,
    liveFor,
    askerLive,
    replyTarget,
    seenOverMcp,
    holdOverMcp,
    route,
    allLive,
    isSessionLive,
    composeTarget,
    connectionOf,
    hostSessions,
    restartCount,
    mcpAgents,
    tagTargets,
  };
}
