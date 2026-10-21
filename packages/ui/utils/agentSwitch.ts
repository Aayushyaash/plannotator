/**
 * Agent Switch Settings Utility
 *
 * Manages settings for automatic agent switching after plan approval and after
 * sending code review feedback. Supports discovered agents, disabled, or custom
 * agent names.
 *
 * The stored value is shared across surfaces, but the default when nothing is
 * stored is surface-specific: plan approval keeps its historical hand-off to the
 * build agent, while review feedback stays on the current agent.
 *
 * Stored through the settings registry (`agentSwitch` in config/settings.ts):
 * cookies (not localStorage, because each hook invocation runs on a random
 * port) plus `agentSwitch` in ~/.plannotator/config.json, which wins over the
 * cookie (#1390: the Glimpse webview keeps no cookies between runs).
 */

import { configStore } from '../config/configStore';

/** The two configStore calls this module makes; tests pass a fresh store. */
interface AgentSwitchStore {
  get(key: 'agentSwitch'): { switchTo: string; customName?: string } | null;
  set(key: 'agentSwitch', value: { switchTo: string; customName?: string } | null): void;
}

// AgentSwitchOption is now a string to support dynamic agent names from OpenCode
export type AgentSwitchOption = string;

export interface AgentSwitchSettings {
  switchTo: AgentSwitchOption;
  customName?: string;
}

// Fallback options when API is unavailable or for non-OpenCode origins
export const AGENT_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: 'build', label: 'Build', description: 'Switch to build agent after approval' },
  { value: 'custom', label: 'Custom', description: 'Switch to a custom agent after approval' },
  { value: 'disabled', label: 'Disabled', description: 'Stay on current agent after approval' },
];

/** UI surface asking for the setting — only affects the unset default. */
export type AgentSwitchSurface = 'plan' | 'review';

const PLAN_DEFAULT_SETTINGS: AgentSwitchSettings = {
  switchTo: 'build',
};

const REVIEW_DEFAULT_SETTINGS: AgentSwitchSettings = {
  switchTo: 'disabled',
};

/**
 * Default used when the user has never picked an agent switch setting.
 * Plan approval hands off to the build agent (historical behavior); review
 * feedback stays on the current agent.
 */
export function getAgentSwitchDefaults(surface: AgentSwitchSurface = 'plan'): AgentSwitchSettings {
  return surface === 'review' ? REVIEW_DEFAULT_SETTINGS : PLAN_DEFAULT_SETTINGS;
}

/**
 * Get current agent switch settings from storage.
 * An explicit user choice applies to every surface; only the unset default
 * varies by surface.
 */
export function getAgentSwitchSettings(
  surface: AgentSwitchSurface = 'plan',
  store: AgentSwitchStore = configStore,
): AgentSwitchSettings {
  const stored = store.get('agentSwitch');
  return stored ? { ...stored } : getAgentSwitchDefaults(surface);
}

/**
 * Save agent switch settings: cookie at once, config.json through the
 * registry's debounced POST /api/config.
 */
export function saveAgentSwitchSettings(
  settings: AgentSwitchSettings,
  store: AgentSwitchStore = configStore,
): void {
  store.set('agentSwitch', {
    switchTo: settings.switchTo,
    ...(settings.customName && { customName: settings.customName }),
  });
}

/**
 * Get the effective agent name for switching
 * Returns undefined if disabled, otherwise returns the agent name
 */
export function getEffectiveAgentName(settings: AgentSwitchSettings): string | undefined {
  if (settings.switchTo === 'disabled') {
    return undefined;
  }
  if (settings.switchTo === 'custom' && settings.customName) {
    return settings.customName;
  }
  if (settings.switchTo === 'custom') {
    return undefined;
  }
  return settings.switchTo;
}

/**
 * The agent name an approval hands off to, for display ("Approve → build"):
 * a discovered agent's display name, the custom name, or the stored id when
 * it matches nothing discovered. Null when switching is off.
 */
export function agentSwitchTargetLabel(
  setting: AgentSwitchSettings,
  agents: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (setting.switchTo === 'disabled') return null;
  if (setting.switchTo === 'custom') return setting.customName || null;
  const match = agents.find((a) => a.id.toLowerCase() === setting.switchTo.toLowerCase());
  return match?.name ?? setting.switchTo;
}
