/**
 * The in-turn "session opened" notice for Pi's slash commands, the
 * `plannotator` tool and plan review.
 *
 * It always carries the URL, local or remote: a local session whose browser
 * opened fine still needs a way back to a closed tab, and the after-turn notify
 * in `openBrowserForServer` fires too late to render. Only the wording around
 * the URL changes with the session.
 */
import { isRemoteSession, isUrlHostOverridden } from "./server/network.ts";

export function sessionOpenedMessage(label: string, url: string): string {
	if (!isRemoteSession()) return `${label} at ${url}. You can keep chatting while it runs.`;
	// With an advertised-URL host override the link is directly reachable
	// (e.g. over a tailnet), so the port-forwarding advice would be wrong.
	return isUrlHostOverridden()
		? `${label} — open ${url} on your device. You can keep chatting while it runs.`
		: `${label} — open ${url} on your local machine (forward the port if needed). You can keep chatting while it runs.`;
}
