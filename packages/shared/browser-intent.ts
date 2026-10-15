/**
 * What the environment asks a session to do about a browser.
 *
 * One rule for both runtimes (vendored to Pi by apps/pi-extension/vendor.sh):
 *
 * - `PLANNOTATOR_BROWSER` (and the CLI's `--browser`, which sets it) belongs to
 *   Plannotator alone. A "none" value there means open nothing at all: no VS
 *   Code IPC, no Glimpse, no `BROWSER`, no system opener, local or remote.
 *   The session URL is always printed, so nothing is lost.
 * - `BROWSER` is shared with other tools and set by hosts (Claude Code's agent
 *   view sets `BROWSER=true` for its own reasons). Its no-op values stay
 *   ignored, as #756 made them, and the default chain runs.
 *
 * Pure: reads only the env it is given.
 */

/** `PLANNOTATOR_BROWSER` values (trimmed, any case) that mean "open nothing". */
export const BROWSER_NONE_VALUES: readonly string[] = ["none", "false", "0", "off", "no", "true", "1", ":"];

/** `BROWSER` values (trimmed, any case) read as "not set" (#756). */
const BROWSER_ENV_NOOP_VALUES: ReadonlySet<string> = new Set(["true", "false", "none", ":", "0", "1"]);

const NONE_VALUES: ReadonlySet<string> = new Set(BROWSER_NONE_VALUES);

/** True when `PLANNOTATOR_BROWSER` (or `--browser`) says to open nothing. */
export function isBrowserNoneValue(value: string | undefined): boolean {
  if (!value) return false;
  return NONE_VALUES.has(value.trim().toLowerCase());
}

/** True for a `BROWSER` value read as unset (#756): a host's "do not launch" marker. */
export function isNoOpBrowserSentinel(value: string | undefined): boolean {
  if (!value) return false;
  return BROWSER_ENV_NOOP_VALUES.has(value.trim().toLowerCase());
}

export type BrowserIntent =
  /** Open nothing. `value` is what PLANNOTATOR_BROWSER held, trimmed. */
  | { kind: "none"; value: string }
  /** Run the default chain: IPC (remote), Glimpse (local), the system opener. */
  | { kind: "default" }
  /** Launch this handler. `source` names the variable it came from. */
  | { kind: "explicit"; browser: string; source: "PLANNOTATOR_BROWSER" | "BROWSER" };

/** Decide from the environment what opening a browser should do. */
export function resolveBrowserIntent(
  env: Record<string, string | undefined> = process.env,
): BrowserIntent {
  const plannotatorBrowser = env.PLANNOTATOR_BROWSER;
  if (plannotatorBrowser && plannotatorBrowser.trim()) {
    if (isBrowserNoneValue(plannotatorBrowser)) {
      return { kind: "none", value: plannotatorBrowser.trim() };
    }
    return { kind: "explicit", browser: plannotatorBrowser, source: "PLANNOTATOR_BROWSER" };
  }
  const browser = env.BROWSER;
  if (browser && browser.trim() && !isNoOpBrowserSentinel(browser)) {
    return { kind: "explicit", browser, source: "BROWSER" };
  }
  return { kind: "default" };
}

/** The sentence said instead of opening a browser: `Not opening a browser (PLANNOTATOR_BROWSER=none).` */
export function browserNoneReason(intent: { value: string }): string {
  return `Not opening a browser (PLANNOTATOR_BROWSER=${intent.value}).`;
}
