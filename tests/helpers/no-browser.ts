/**
 * "Open no browser" for tests and dev scripts: the value to give
 * PLANNOTATOR_BROWSER so that a session's openBrowser() runs a program that
 * exits at once and opens nothing.
 *
 * Why not `PLANNOTATOR_BROWSER=none`: a current build opens nothing for it
 * (packages/shared/browser-intent.ts), but a binary from before that change
 * read `none`, `true`, `false`, `:`, `0` and `1` as "no browser configured"
 * (#756) and fell through to the system default: `open <url>` on macOS,
 * `xdg-open` on Linux. Tests can reach such a binary (the version matrix, an
 * older installed `plannotator`), and a bug in the "none" handling itself
 * would do the same, so a test that sets `none` could open real tabs on the
 * developer's screen. tests/no-browser-sentinel.test.ts fails on any test or
 * script that does, except a line marked as testing that handling.
 *
 * The value is an absolute path, so it works under any PATH a test builds
 * (some specs give the binary a PATH of fakes only):
 *  - POSIX: `/usr/bin/true` (macOS and Linux), else `/bin/true`, else the
 *    first executable `true` on PATH. openBrowser runs a path with a `/`
 *    directly on macOS (`<path> <url>`, never `open -a`) and on Linux.
 *  - Windows: `%SystemRoot%\System32\whoami.exe`, the no-op .github/workflows/
 *    test.yml already uses for this. openBrowser runs it as
 *    `cmd.exe /c start "" <path> <url>`: whoami refuses the URL argument and
 *    exits, `start` returns 0, and no browser opens (a console window may
 *    flash). No CI job runs these tests on Windows today.
 *
 * Node-safe (no Bun APIs): the Playwright specs import it under node.
 */
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function resolveNoBrowser(): string {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const whoami = join(root, "System32", "whoami.exe");
    if (isExecutable(whoami)) return whoami;
    throw new Error(`tests/helpers/no-browser.ts: ${whoami} not found; no no-op program to give PLANNOTATOR_BROWSER.`);
  }
  for (const candidate of ["/usr/bin/true", "/bin/true"]) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !entry.startsWith("/")) continue;
    const candidate = join(entry, "true");
    if (isExecutable(candidate)) return candidate;
  }
  // Never fall back to a sentinel: that is the bug this file exists to avoid.
  throw new Error("tests/helpers/no-browser.ts: no `true` executable found; no no-op program to give PLANNOTATOR_BROWSER.");
}

/** Set PLANNOTATOR_BROWSER to this in every test and script that must open no browser. */
export const NO_BROWSER: string = resolveNoBrowser();
