/**
 * Running `git` and `gh` for the Guides view. Every data source takes a
 * `Runner`, so tests inject a scripted one and never touch a real repository
 * or the GitHub CLI.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** Stop reading stdout past this many bytes (the result is then marked truncated). */
  maxOutputBytes?: number;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult & { truncated?: boolean }>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

/** Directories GUI-launched editors often miss on PATH (macOS Dock launches). */
function extraSearchDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") return [];
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin")];
}

/** The absolute path of an executable on PATH (plus the usual extra dirs), or null. */
export function findExecutable(name: string, env: Record<string, string | undefined> = process.env): string | null {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extraSearchDirs()];
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH with the extra dirs appended, for child processes. */
export function augmentedPath(env: Record<string, string | undefined> = process.env): string {
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of extraSearchDirs()) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

/** The real runner: no shell, a timeout that kills the process, bounded output. */
export const defaultRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const resolved = findExecutable(command) ?? command;
    let child;
    try {
      child = spawn(resolved, args, {
        cwd: options.cwd,
        env: { ...process.env, PATH: augmentedPath(), ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (result: RunResult & { truncated?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout: Buffer.concat(out).toString("utf8"), stderr: `${Buffer.concat(errOut).toString("utf8")}\n(timed out)` });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errOut.reduce((n, b) => n + b.length, 0) < 1024 * 1024) errOut.push(chunk);
    });
    child.on("error", (err) => finish({ code: 127, stdout: "", stderr: err.message }));
    child.on("close", (code) =>
      finish({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errOut).toString("utf8"), ...(truncated && { truncated }) }),
    );
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
