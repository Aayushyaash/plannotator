/**
 * What the window says about notifications, in plain words (Settings →
 * General and the line above the list). Pure: the browser and the server's
 * report come in as arguments, so every state is testable.
 *
 * The states that make notifications fail silently, each named here:
 * - this address has no permission (`default`), maybe because the Inbox moved
 *   to another port or another spelling of this computer's name;
 * - the browser blocked this address (`denied`);
 * - the switch is off;
 * - no Inbox tab is open, or none the browser lets notify (the server's
 *   `notify_reach`: notifications come only from an open tab);
 * - the browser says yes but the system does not show them (macOS
 *   Notifications for the browser off, Focus): only a test shows that.
 */

import type { InboxNotifyReach } from '@plannotator/core/inbox-types';

export type PermissionState = NotificationPermission | 'unsupported';

/** The browser's name as a person knows it, from the user agent. */
export function browserName(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/\bEdg\//.test(userAgent)) return 'Edge';
  if (/\bFirefox\//.test(userAgent)) return 'Firefox';
  // Chrome, Chromium-based browsers that say Chrome (Arc, Brave), and headless Chrome ("HeadlessChrome/").
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/\bSafari\//.test(userAgent)) return 'Safari';
  return 'this browser';
}

/** The browser's app name in macOS System Settings → Notifications. */
export function browserAppName(name: string): string {
  if (name === 'Chrome') return 'Google Chrome';
  if (name === 'Edge') return 'Microsoft Edge';
  return name === 'this browser' ? 'your browser' : name;
}

export function isMac(platform: string = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : ''): boolean {
  return /Mac/i.test(platform);
}

/** `localhost:59812`: an origin as a person reads it. */
export function addressOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The status under "Desktop notifications" in Settings. */
export type NotifyStatusKind = 'on' | 'off' | 'not-allowed' | 'blocked' | 'unsupported';

export function notifyStatusKind(enabled: boolean, permission: PermissionState): NotifyStatusKind {
  if (permission === 'unsupported') return 'unsupported';
  if (permission === 'denied') return 'blocked';
  if (permission === 'default') return 'not-allowed';
  return enabled ? 'on' : 'off';
}

export function notifyStatusText(kind: NotifyStatusKind, browser: string): string {
  switch (kind) {
    case 'on':
      return 'On for this address';
    case 'off':
      return 'Off';
    case 'not-allowed':
      return `Not allowed in ${browser} for this address`;
    case 'blocked':
      return `Blocked in ${browser} for this address`;
    case 'unsupported':
      return 'This browser cannot show notifications';
  }
}

/** How to unblock this address, in the browser's own words. */
export function blockedSteps(browser: string, address: string): string {
  if (browser === 'Safari') return `In Safari: Settings → Websites → Notifications → ${address} → Allow. Then reload this page.`;
  if (browser === 'Firefox') return `Click the icon left of ${address} in the address bar → Permissions → Send notifications → remove "Blocked". Then reload this page.`;
  return `Click the icon left of ${address} in the address bar → Site settings → Notifications → Allow. Then reload this page.`;
}

/** Under the test button: why a test the browser accepted may still not show. */
export function testMissHint(browser: string, mac: boolean): string {
  const app = browserAppName(browser);
  return mac
    ? `Didn't see it? Check System Settings → Notifications → ${app}, and Focus.`
    : `Didn't see it? Check your system's notification settings for ${app}, and Do Not Disturb.`;
}

/**
 * "Notifications reach you": whether any open Inbox tab can show one now.
 * `here`: this tab may notify (switch on, browser allows). `reach`: the
 * server's count of open windows, this one included; null from an Inbox that
 * does not report it (then only this tab is known).
 */
export function reachText(input: { here: boolean; enabled: boolean; reach: InboxNotifyReach | null | undefined; origin: string }): { yes: boolean; text: string } {
  const { here, enabled, reach, origin } = input;
  if (!enabled) return { yes: false, text: 'No: notifications are off.' };
  if (!reach) return here ? { yes: true, text: 'Yes, through this tab, while it stays open.' } : { yes: false, text: 'No: this tab may not notify.' };
  const others = Math.max(0, reach.allowed - (here ? 1 : 0));
  if (here) {
    return {
      yes: true,
      text: others > 0 ? `Yes, through this tab and ${others} other Inbox ${others === 1 ? 'tab' : 'tabs'}, while one stays open.` : 'Yes, through this tab, while it stays open.',
    };
  }
  if (reach.allowed > 0) {
    const elsewhere = reach.allowed_origins.filter((o) => o !== origin).map(addressOf);
    return { yes: true, text: `Yes, through another Inbox tab${elsewhere.length > 0 ? ` (${elsewhere.join(', ')})` : ''}.` };
  }
  if (reach.windows === 0) return { yes: false, text: 'No: no Inbox tab is open.' };
  return {
    yes: false,
    text: reach.windows > 1 ? `No: none of the ${reach.windows} open Inbox tabs may notify.` : 'No: no open Inbox tab may notify.',
  };
}
