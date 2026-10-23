// ── Permission helpers ────────────────────────────────────────────────────

/**
 * Normalize an `edit` permission value before merging additional rules.
 *
 * OpenCode's zod transform converts legacy `tools: { edit: false }` to
 * `permission.edit = "deny"` (a plain string) before any plugin sees the
 * config.  Spreading a string in JS produces char-index keys:
 *   `{ ..."deny" }` → `{ "0": "d", "1": "e", "2": "n", "3": "y" }`
 * which corrupt the permission ruleset and cause zod validation failures.
 *
 * This function converts a string action to `{ "*": action }` (equivalent
 * wildcard object) so the caller can safely spread it and add overrides.
 */
export function normalizeEditPermission(
  edit: string | Record<string, string> | undefined,
): Record<string, string> {
  if (typeof edit === "string") {
    return { "*": edit };
  }
  return edit ?? {};
}

// ── Prompt stripping ──────────────────────────────────────────────────────

export interface StripPlanModeOptions {
  /**
   * Also strip OpenCode 2's Plan mode wording (#2101): "discuss the plan with
   * the user directly", "do not create or update plan files", and lines naming
   * its plan directory (`.opencode/plan`, singular, or `.opencode/plans`).
   * Only the OpenCode 2 adapter passes it, so OpenCode 1 strips exactly what
   * it always did.
   */
  openCode2?: boolean;
}

/** `.opencode/plan` or `.opencode/plans`, either separator, not `.opencode/planning`. */
const OPENCODE_PLAN_DIRECTORY = /\.opencode[\\/]plans?(?![a-z0-9_-])/;

function shouldStripPlanModeLine(line: string, options: StripPlanModeOptions): boolean {
  const normalized = line.trim().toLowerCase();
  if (normalized.includes("strictly forbidden: any file edits")
    || normalized.includes("your plan at ")
    || normalized.includes("plan file already exists at ")
    || normalized.includes(".opencode/plans/")
    || normalized.includes("plan_exit")
    || (normalized.includes("agent's conversation") && normalized.includes("not on disk"))) return true;
  if (!options.openCode2) return false;
  return normalized.includes("discuss the plan with the user directly")
    || normalized.includes("do not create or update plan files")
    || OPENCODE_PLAN_DIRECTORY.test(normalized);
}

function cleanupSystemEntry(entry: string): string {
  return entry
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripConflictingPlanModeRules(
  systemEntries: string[],
  options: StripPlanModeOptions = {},
): string[] {
  return systemEntries
    .map((entry) =>
      cleanupSystemEntry(
        entry
          .split("\n")
          .filter((line) => !shouldStripPlanModeLine(line, options))
          .join("\n"),
      ),
    )
    .filter(Boolean);
}

export function composeSystemPrompt(system: string[], additions: string[]): string[] {
  return [system.concat(additions).map((s) => s.trim()).filter(Boolean).join("\n\n")];
}
