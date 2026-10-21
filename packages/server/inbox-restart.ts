/**
 * Plannotator Inbox: which agent sessions need a restart after an update
 * (owner approval "restart-warning", 2026-10-19; design record not in this
 * repo).
 *
 * The Claude Code mod reports what it loaded on every bridge poll
 * (`plugin: { version, root, loaded_at }`, read once when the module loads,
 * and `engine`). A restart of that Claude Code would load the plugin Claude
 * Code has installed now, which its registry records
 * (`<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`: `version`,
 * `installPath`, `lastUpdated`). A session is outdated when what it loaded is
 * not what a restart loads:
 *  - the versions differ;
 *  - its plugin folder is not the installed one (an update into a new folder);
 *  - it loaded the plugin before the registry's `lastUpdated` AND before the
 *    install folder last changed (an update that reused the folder and kept
 *    the version: only this rule catches it; `lastUpdated` alone moves for a
 *    project-scope install of the same folder with no new code).
 * The record judged against is the one a restart would load: the record whose
 * `installPath` is the folder the session loaded, then a project-scope record
 * whose `projectPath` holds the session's folder, then the user record. Only
 * `plannotator@plannotator` counts (a fork from another marketplace is
 * another plugin). Paths compare by their real paths (`realish`).
 * A session that polls with no `plugin` field runs a mod older than the field
 * (`PLUGIN_REPORTS_LOADED_SINCE`); when the installed plugin is at least that
 * release, a restart loads a newer one, so it is outdated with its version
 * unknown.
 *
 * When the installed plugin is itself behind this Inbox's Plannotator (the
 * plugin was not updated: `--skip-claude-plugin`, a marketplace not updated),
 * a restart does not help: `fix: "update_plugin"`, with the command.
 *
 * Only the rules above are judged for a plugin loaded from Claude Code's own
 * plugin folder. A session started with `claude --plugin-dir <dir>` (a
 * checkout) reloads that folder when restarted, so the installed record says
 * nothing about it: never outdated.
 *
 * Pi reports its extension's version only (it has no registry the Inbox can
 * read): behind this Inbox's own release it is `fix: "update_extension"`
 * (`pi update --extensions`, then `/reload`).
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { INBOX_PLUGIN_REPORTS_LOADED_SINCE, type InboxSessionOutdated } from "@plannotator/core/inbox-types";
import { compareStableVersions, parseStableVersion, CLAUDE_PLUGIN_UPDATE_COMMANDS } from "@plannotator/shared/update-check";
import { readAgentFile } from "./agent-files";
import { claudeConfigDir, type AgentEnvironment } from "./inbox-agents";

/**
 * The first Plannotator release whose Claude Code mod reports `plugin` on its
 * poll (one constant, in core, beside `INBOX_SEND_NOW_SINCE`). An installed
 * plugin at least this new, polled by a session that sends no `plugin`,
 * means a restart loads a newer plugin than the session runs. This must merge
 * before the version bump to it.
 */
export const PLUGIN_REPORTS_LOADED_SINCE = INBOX_PLUGIN_REPORTS_LOADED_SINCE;

/**
 * Plannotator's plugin as the repo's marketplace names it
 * (`.claude-plugin/marketplace.json`: marketplace `plannotator`, plugin
 * `plannotator`). A fork installed from another marketplace is another plugin
 * and is never judged against.
 */
export const CLAUDE_PLUGIN_KEY = "plannotator@plannotator";

/** What a session's poll said it loaded (validated). */
export interface LoadedPlugin {
  version: string | null;
  root: string | null;
  /** When the module loaded, ms. */
  loadedAt: number | null;
}

/** One record of Plannotator's plugin in Claude Code's registry. */
export interface ClaudePluginInstall {
  version: string | null;
  installPath: string | null;
  /** `lastUpdated` (else `installedAt`), ms. */
  lastUpdated: number | null;
  /** `user`, `project`, `local`... (absent in the v1 file: user). */
  scope: string | null;
  /** The project a project- or local-scope record belongs to. */
  projectPath: string | null;
}

const MAX_FIELD = 4096;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= MAX_FIELD ? value.trim() : null);
const abs = (value: unknown): string | null => {
  const text = str(value);
  return text && isAbsolute(text) ? text : null;
};
const ms = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

/**
 * A poll's `plugin` field: null only when absent (a mod older than the
 * field). A current mod always sends it, with `version` or `root` null when it
 * could not read them, so a read that failed is never taken for an old mod.
 */
export function parseLoadedPlugin(value: unknown): LoadedPlugin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return { version: str(record.version), root: abs(record.root), loadedAt: ms(record.loaded_at) };
}

/** A poll's `engine` field (Claude Code's own version). */
export function parseEngine(value: unknown): string | null {
  const text = str(value);
  return text && text.length <= 64 ? text : null;
}

/** A poll's `session_folder`: where the session started (its `claude --resume` folder). */
export function parseSessionFolder(value: unknown): string | null {
  return abs(value);
}

/** Every record of `plannotator@plannotator` in `installed_plugins.json` (v2 `{ plugins: { id: [records] } }`, or the v1 object). */
export function parseClaudePluginInstalls(text: string): ClaudePluginInstall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as { plugins?: unknown } & Record<string, unknown>;
  const table = (root.plugins && typeof root.plugins === "object" ? root.plugins : root) as Record<string, unknown>;
  const value = table[CLAUDE_PLUGIN_KEY];
  const out: ClaudePluginInstall[] = [];
  for (const record of Array.isArray(value) ? value : value ? [value] : []) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const r = record as Record<string, unknown>;
    out.push({
      version: str(r.version),
      installPath: abs(r.installPath),
      lastUpdated: ms(r.lastUpdated) ?? ms(r.installedAt),
      scope: str(r.scope),
      projectPath: abs(r.projectPath),
    });
  }
  return out;
}

/** The user-scope record (a record without `scope`, the v1 file, counts as user), else the first. */
export function parseClaudePluginInstall(text: string): ClaudePluginInstall | null {
  const records = parseClaudePluginInstalls(text);
  return userRecord(records);
}

const userRecord = (records: readonly ClaudePluginInstall[]) => records.find((r) => r.scope === null || r.scope === "user") ?? records[0] ?? null;

/**
 * A path as the file system sees it: the real path of its deepest existing
 * part, the rest joined on. Both sides of every comparison go through it, so a
 * symlinked `~/.claude` or CLAUDE_CONFIG_DIR neither hides nor invents a
 * difference, and a folder deleted since (an old version's cache) still
 * compares by where it was.
 */
export function realish(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length ? join(realpathSync(head), ...rest.reverse()) : realpathSync(head);
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.push(basename(head));
      head = up;
    }
  }
}

const isUnder = (path: string, dir: string) => {
  const a = realish(path);
  const b = realish(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/**
 * The record a restart of this session would load: the one whose
 * `installPath` is the folder the session loaded, then a project- or
 * local-scope record whose `projectPath` holds the session's folder, then the
 * user record.
 */
export function chooseClaudePluginInstall(
  records: readonly ClaudePluginInstall[],
  session: { loadedRoot: string | null; folder: string | null },
): ClaudePluginInstall | null {
  if (records.length === 0) return null;
  if (session.loadedRoot) {
    const root = realish(session.loadedRoot);
    const same = records.find((r) => r.installPath && realish(r.installPath) === root);
    if (same) return same;
  }
  if (session.folder) {
    const holding = records
      .filter((r) => r.projectPath && r.scope !== "user" && isUnder(session.folder!, r.projectPath))
      .sort((a, b) => realish(b.projectPath!).length - realish(a.projectPath!).length)[0];
    if (holding) return holding;
  }
  return userRecord(records);
}

/** How long a read of the registry is reused: every poll and every window read asks. */
const INSTALL_FRESH_MS = 2_000;

/**
 * When an installed plugin folder last changed: its `.claude-plugin/plugin.json`
 * (rewritten by every install into it), else the folder itself; null when
 * neither exists.
 */
export function pluginFolderChangedAt(installPath: string): number | null {
  for (const path of [join(installPath, ".claude-plugin", "plugin.json"), installPath]) {
    try {
      const stat = statSync(path);
      return Math.max(stat.mtimeMs, lstatSync(path).mtimeMs);
    } catch {
      // Next.
    }
  }
  return null;
}

/** Reads Claude Code's plugin registry for Plannotator's records, at most once per `INSTALL_FRESH_MS`. */
export function createClaudePluginInstallReader(environment: AgentEnvironment, now: () => number = Date.now) {
  let cached: { at: number; value: ClaudePluginInstall[] } | null = null;
  const changed = new Map<string, { at: number; value: number | null }>();
  const records = (): ClaudePluginInstall[] => {
    if (cached && now() - cached.at < INSTALL_FRESH_MS) return cached.value;
    const file = readAgentFile(join(claudeConfigDir(environment), "plugins", "installed_plugins.json"));
    const value = file.kind === "file" ? parseClaudePluginInstalls(file.text) : [];
    cached = { at: now(), value };
    return value;
  };
  const changedAt = (installPath: string): number | null => {
    const hit = changed.get(installPath);
    if (hit && now() - hit.at < INSTALL_FRESH_MS) return hit.value;
    const value = pluginFolderChangedAt(installPath);
    changed.set(installPath, { at: now(), value });
    return value;
  };
  return {
    records,
    /** The user-scope record: what a restart in a folder with no project install of its own loads. */
    read: () => userRecord(records()),
    changedAt,
    pluginsDir: () => join(claudeConfigDir(environment), "plugins"),
  };
}

const isRelease = (version: string | null | undefined): version is string => !!version && parseStableVersion(version) !== null;

/** Whether `a` is older than `b`, both releases; false when either is not one. */
const older = (a: string | null, b: string | null) => isRelease(a) && isRelease(b) && compareStableVersions(a, b) === -1;

export interface ClaudeSessionJudgeInput {
  /** What the session's poll said it loaded; null: it sent no `plugin` (a mod older than the field). */
  loaded: LoadedPlugin | null;
  /** The registry's records of `plannotator@plannotator`; the right one is chosen for this session. */
  records: readonly ClaudePluginInstall[];
  /** Where the session started (its folder), for a project-scope record. */
  folder: string | null;
  cliVersion: string;
  /** Claude Code's plugin folder. */
  pluginsDir: string;
  /** When an install folder last changed (`pluginFolderChangedAt`). */
  changedAt?: (installPath: string) => number | null;
}

/**
 * Claude Code: whether a session runs an older plugin than a restart loads,
 * or than this Inbox. `cliVersion` is this Inbox's version (`dev` and other
 * non-releases skip the plugin-behind-Inbox rule).
 */
export function claudeSessionOutdated(input: ClaudeSessionJudgeInput): InboxSessionOutdated | null {
  const outdated = judgeClaudeSession(input);
  return outdated?.fix === "update_plugin" ? { ...outdated, update_command: CLAUDE_PLUGIN_UPDATE_COMMAND } : outdated;
}

function judgeClaudeSession(input: ClaudeSessionJudgeInput): InboxSessionOutdated | null {
  const { loaded, cliVersion } = input;
  const install = chooseClaudePluginInstall(input.records, { loadedRoot: loaded?.root ?? null, folder: input.folder });
  if (!install) return null;
  const installed = install.version;
  const installedBehindInbox = older(installed, cliVersion);
  if (!loaded) {
    // A mod older than the field. It runs at most the installed plugin; when that is new enough to report, a restart brings it.
    if (isRelease(installed) && compareStableVersions(installed, PLUGIN_REPORTS_LOADED_SINCE)! >= 0) {
      return { loaded: null, installed, fix: installedBehindInbox ? "update_plugin" : "restart" };
    }
    return installedBehindInbox ? { loaded: null, installed, fix: "update_plugin" } : null;
  }
  // A plugin loaded from outside Claude Code's plugin folder reloads that same folder when restarted, so the
  // registry says nothing about it: `claude --plugin-dir <dir>`, and a local (directory) marketplace, which
  // Claude Code loads in place. Never flagged.
  if (loaded.root && !isUnder(loaded.root, input.pluginsDir)) return null;
  const versionDiffers = !!loaded.version && !!installed && loaded.version !== installed;
  const folderDiffers = !!loaded.root && !!install.installPath && realish(loaded.root) !== realish(install.installPath);
  // Reinstalled into the same folder with the same version after the session loaded it: only the load time
  // tells. The registry's `lastUpdated` alone is not enough (a project-scope install of the same folder bumps
  // it with no new code), so the folder itself must have changed since the session loaded it too.
  const folderChangedAt = install.installPath ? (input.changedAt ?? pluginFolderChangedAt)(install.installPath) : null;
  const loadedBefore =
    loaded.loadedAt !== null &&
    install.lastUpdated !== null &&
    folderChangedAt !== null &&
    loaded.loadedAt < install.lastUpdated &&
    loaded.loadedAt < folderChangedAt;
  // Behind this Inbox, and the installed plugin too: a restart alone loads another old plugin.
  if (installedBehindInbox && (older(loaded.version, cliVersion) || !loaded.version)) return { loaded: loaded.version, installed, fix: "update_plugin" };
  if (versionDiffers || folderDiffers || loadedBefore) return { loaded: loaded.version, installed, fix: "restart" };
  return null;
}

/** Whether Claude Code's installed plugin is behind this Inbox's release (a restart alone would not help). */
export function claudePluginBehindInbox(install: ClaudePluginInstall | null, cliVersion: string): boolean {
  return !!install && older(install.version, cliVersion);
}

/** Pi: the extension's version behind this Inbox's release (`pi update --extensions`, then `/reload`). */
export function piSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string): InboxSessionOutdated | null {
  if (!loaded?.version || !older(loaded.version, cliVersion)) return null;
  return { loaded: loaded.version, installed: cliVersion, fix: "update_extension" };
}

/** The command that updates the Claude Code plugin itself (the install script's two steps). */
export const CLAUDE_PLUGIN_UPDATE_COMMAND = `${CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ")} --scope user`;

/** A folder for a shell line: `~` kept unquoted at the start, anything unusual single-quoted. */
export function shellFolder(folder: string): string {
  const safe = /^[A-Za-z0-9_./+@:,=-]+$/;
  if (folder === "~") return "~";
  if (folder.startsWith("~/")) {
    const rest = folder.slice(2);
    return rest === "" || safe.test(rest) ? folder : `~/${singleQuote(rest)}`;
  }
  return safe.test(folder) ? folder : singleQuote(folder);
}

const singleQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `cd <folder> && claude --resume <session>`: the same Claude Code session again, in its folder. */
export function claudeRestartCommand(folder: string, session: string): string {
  const id = /^[A-Za-z0-9._-]+$/.test(session) ? session : singleQuote(session);
  return `cd ${shellFolder(folder)} && claude --resume ${id}`;
}
