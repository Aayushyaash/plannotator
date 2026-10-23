/**
 * ACP adapters Guided Reviews installs itself.
 *
 * Some agents speak ACP only through a separate npm adapter (Claude Code's
 * `claude-agent-acp`, `codex-acp`, `pi-acp`). When the adapter is neither set
 * in settings nor on PATH, Guided Reviews installs the exact version pinned in
 * the agent table into the extension's own storage
 * (`<globalStorage>/adapters/<agent id>`), with `npm install --prefix … --ignore-scripts`:
 * no global install, no sudo, no `npx` at run time. The installed copy is
 * reused until the pinned version changes or the user runs "Update Agent
 * Adapters". Agents that are their own CLI (OpenCode, Copilot, Cursor, Kiro,
 * Kilo) are never installed here.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findExecutable, type Runner } from "../sources/runner";

/** An npm package that starts the agent's ACP server, pinned to one version. */
export interface ManagedAdapterSpec {
  package: string;
  /** Exact version (published at least 7 days before it was pinned). */
  version: string;
  /** The package's `bin` entry to run. */
  bin: string;
}

/** What `managedLaunch` answers: run `command args` (with `env`). */
export interface ManagedLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  dir: string;
}

const MARKER = "plannotator-adapter.json";
const INSTALL_TIMEOUT_MS = 10 * 60_000;

interface Marker {
  package: string;
  version: string;
  /** "node": the `node` on PATH meets the package's engines; "vscode": run it with VS Code's own runtime. */
  runtime: "node" | "vscode";
}

export function adaptersRoot(globalStorage: string): string {
  return join(globalStorage, "adapters");
}

export function managedDir(root: string, agentId: string): string {
  return join(root, agentId);
}

/** The command a person can run instead: a global install of the same pinned version. */
export function manualInstallCommand(spec: ManagedAdapterSpec): string {
  return `npm install -g ${spec.package}@${spec.version}`;
}

export interface LaunchDeps {
  findNode?: () => string | null;
  execPath?: string;
}

/**
 * The installed copy, when it is the pinned version and its entry file is
 * there; else null (not installed, an older pin, or a broken install).
 */
export function managedLaunch(root: string, agentId: string, spec: ManagedAdapterSpec, agentArgs: readonly string[], deps: LaunchDeps = {}): ManagedLaunch | null {
  const dir = managedDir(root, agentId);
  const marker = readJson<Marker>(join(dir, MARKER));
  if (!marker || marker.package !== spec.package || marker.version !== spec.version) return null;
  const entry = binEntry(dir, spec);
  if (!entry) return null;
  const node = marker.runtime === "node" ? (deps.findNode ?? (() => findExecutable("node")))() : null;
  if (node) return { command: node, args: [entry, ...agentArgs], dir };
  // VS Code's own runtime (Electron run as Node): no Node on PATH needed at run time.
  return { command: deps.execPath ?? process.execPath, args: [entry, ...agentArgs], env: { ELECTRON_RUN_AS_NODE: "1" }, dir };
}

/** The JavaScript file a package's `bin` entry names, inside `<dir>/node_modules/<package>`. */
function binEntry(dir: string, spec: ManagedAdapterSpec): string | null {
  const pkgDir = join(dir, "node_modules", ...spec.package.split("/"));
  const pkg = readJson<{ version?: string; bin?: string | Record<string, string> }>(join(pkgDir, "package.json"));
  if (!pkg || pkg.version !== spec.version) return null;
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[spec.bin];
  if (!rel) return null;
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (parts.includes("..")) return null;
  const entry = join(pkgDir, ...parts);
  return existsSync(entry) ? entry : null;
}

export interface InstallDeps {
  runner: Runner;
  findExecutable?: (name: string) => string | null;
  platform?: NodeJS.Platform;
  /** For tests: a fixed suffix for the staging folder. */
  stamp?: string;
}

export type InstallResult = { ok: true; dir: string } | { ok: false; message: string };

/**
 * `npm install --prefix <staging> --ignore-scripts <package>@<version>`, then
 * the staging folder replaces the old copy (which stays usable if this fails).
 * One line of reason and the manual command on failure.
 */
export async function installAdapter(root: string, agentId: string, agentLabel: string, spec: ManagedAdapterSpec, deps: InstallDeps): Promise<InstallResult> {
  const find = deps.findExecutable ?? findExecutable;
  const manual = manualInstallCommand(spec);
  const npm = npmCommand(find, deps.platform ?? process.platform);
  if (!npm) return { ok: false, message: `Could not install ${agentLabel}'s ACP adapter: npm is not on PATH (install Node.js from nodejs.org). Or run \`${manual}\` yourself.` };
  const dir = managedDir(root, agentId);
  const staging = `${dir}.installing-${deps.stamp ?? `${process.pid}-${Date.now()}`}`;
  try {
    mkdirSync(staging, { recursive: true });
    // A package.json of its own, so npm never walks up into some other project.
    writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: `plannotator-adapter-${agentId}`, private: true }, null, 2)}\n`);
  } catch (err) {
    return { ok: false, message: `Could not install ${agentLabel}'s ACP adapter: ${oneLine(err instanceof Error ? err.message : String(err))}. Or run \`${manual}\` yourself.` };
  }
  const args = [...npm.args, "install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error", `${spec.package}@${spec.version}`];
  const result = await deps.runner(npm.command, args, { cwd: staging, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0) {
    rmSync(staging, { recursive: true, force: true });
    const reason = result.code === 124 ? "npm timed out" : npmReason(result.stderr || result.stdout) || `npm exited with code ${result.code}`;
    return { ok: false, message: `Could not install ${agentLabel}'s ACP adapter: ${reason}. Or run \`${manual}\` yourself.` };
  }
  if (!binEntry(staging, spec)) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, message: `Could not install ${agentLabel}'s ACP adapter: npm finished but ${spec.bin} is missing. Or run \`${manual}\` yourself.` };
  }
  const runtime = await nodeMeetsEngines(staging, spec, find, deps.runner);
  writeFileSync(join(staging, MARKER), `${JSON.stringify({ package: spec.package, version: spec.version, runtime } satisfies Marker, null, 2)}\n`);
  try {
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, message: `Could not install ${agentLabel}'s ACP adapter: ${oneLine(err instanceof Error ? err.message : String(err))}. Or run \`${manual}\` yourself.` };
  }
  return { ok: true, dir };
}

/** Whether a copy Guided Reviews installed is there (any version), for "Update Agent Adapters". */
export function hasManagedCopy(root: string, agentId: string): boolean {
  return existsSync(join(managedDir(root, agentId), MARKER));
}

/**
 * npm itself. On Windows `npm.cmd` cannot be spawned without a shell, so run
 * the `npm-cli.js` beside it with Node (not tested on Windows itself).
 */
export function npmCommand(find: (name: string) => string | null, platform: NodeJS.Platform): { command: string; args: string[] } | null {
  const npm = find("npm");
  if (!npm) return null;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(npm)) return { command: npm, args: [] };
  const cli = join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const node = find("node");
  return node && existsSync(cli) ? { command: node, args: [cli] } : null;
}

/** `node` on PATH, when its major version meets the package's `engines.node` (`>=N`); else VS Code's runtime. */
async function nodeMeetsEngines(dir: string, spec: ManagedAdapterSpec, find: (name: string) => string | null, runner: Runner): Promise<"node" | "vscode"> {
  const node = find("node");
  if (!node) return "vscode";
  const pkg = readJson<{ engines?: { node?: string } }>(join(dir, "node_modules", ...spec.package.split("/"), "package.json"));
  const min = /^\s*>=?\s*v?(\d+)/.exec(pkg?.engines?.node ?? "")?.[1];
  if (!min) return "node";
  const r = await runner(node, ["--version"], { timeoutMs: 10_000 });
  const major = /^v?(\d+)/.exec(r.stdout.trim())?.[1];
  return r.code === 0 && major && Number(major) >= Number(min) ? "node" : "vscode";
}

/** The line of npm's output that says what went wrong. */
export function npmReason(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/^npm (?:ERR!|error)\s*/i, "").trim()).filter((l) => l && !/^(?:A complete log|Log files|\d{4}-\d\d-\d\dT)/i.test(l));
  const code = lines.find((l) => /^code\s+\S+/i.test(l));
  const first = lines.find((l) => !/^code\s+/i.test(l)) ?? "";
  return oneLine([code?.replace(/^code\s+/i, ""), first].filter(Boolean).join(": ")).slice(0, 240);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
