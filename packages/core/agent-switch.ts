/**
 * OpenCode's agent switch: which agent the session hands over to after a plan
 * is approved or code review feedback is sent.
 *
 * The choice is stored in a cookie AND in ~/.plannotator/config.json
 * (`agentSwitch`, #1390), because some webviews (Glimpse's WKWebView) keep no
 * cookies between runs, and a forgotten choice silently hands the session to
 * the build agent.
 *
 * Browser-safe and dependency-free: the UI's settings codec, the config
 * readers and every server's POST /api/config allowlist parse through the
 * same functions here, so they cannot disagree about what a valid value is.
 *
 * config.json shapes:
 *   "agentSwitch": "disabled"                                    stay on the current agent
 *   "agentSwitch": "build"                                       any agent name
 *   "agentSwitch": { "switchTo": "custom", "customName": "x" }   the Custom field
 *   "agentSwitch": "custom"                                      Custom with no name (no switch)
 */

/** A choice as the UI holds it. `switchTo` is "disabled", "custom" or an agent name. */
export interface AgentSwitchChoice {
  switchTo: string;
  customName?: string;
}

/** What config.json holds under `agentSwitch`. */
export type AgentSwitchConfigValue = string | { switchTo: "custom"; customName: string };

/** Longest agent name accepted. OpenCode agent names are short identifiers. */
export const AGENT_SWITCH_NAME_MAX = 128;

/**
 * A usable agent name (or "disabled" / "custom"): a non-empty string with no
 * surrounding whitespace, no control characters, at most AGENT_SWITCH_NAME_MAX
 * characters. Any such name is accepted, as before: agent lists are
 * discovered from OpenCode at run time, so no fixed set exists to check.
 */
export function isAgentSwitchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > AGENT_SWITCH_NAME_MAX) return false;
  if (value.trim() !== value) return false;
  // C0 and C1 control characters, DEL, line and paragraph separators.
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

/**
 * Read a config.json (or POST /api/config) value. Anything malformed is
 * undefined, so a hand-edited typo never reaches the agent: the caller keeps
 * its cookie or the surface's default.
 */
export function parseAgentSwitchConfig(value: unknown): AgentSwitchChoice | undefined {
  if (isAgentSwitchName(value)) return { switchTo: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.switchTo !== "custom") return undefined;
  if (!isAgentSwitchName(record.customName)) return undefined;
  return { switchTo: "custom", customName: record.customName };
}

/**
 * The config.json value for a choice: a plain string unless it is the Custom
 * field with a name, which keeps its own shape so the Settings dialog shows
 * the Custom field again instead of "<name> (not found)".
 */
export function agentSwitchConfigValue(choice: AgentSwitchChoice): AgentSwitchConfigValue | undefined {
  if (choice.switchTo === "custom" && isAgentSwitchName(choice.customName)) {
    return { switchTo: "custom", customName: choice.customName };
  }
  return isAgentSwitchName(choice.switchTo) ? choice.switchTo : undefined;
}
