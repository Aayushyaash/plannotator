/**
 * The in-turn "session opened" notice for Pi's slash commands, the
 * `plannotator` tool and plan review.
 *
 * It always carries the URL, local or remote: a local session whose browser
 * opened fine still needs a way back to a closed tab, and the after-turn notify
 * in `openBrowserForServer` fires too late to render. Only the wording around
 * the URL changes with the session. With PLANNOTATOR_BROWSER=none it also says
 * that no browser is opened, and why.
 */
import { browserNoneReason, resolveBrowserIntent } from "./generated/browser-intent.ts";
import { isRemoteSession, isUrlHostOverridden } from "./server/network.ts";

export function sessionOpenedMessage(label: string, url: string): string {
	const intent = resolveBrowserIntent(process.env);
	const tail = intent.kind === "none"
		? ` ${browserNoneReason(intent)} You can keep chatting while it runs.`
		: " You can keep chatting while it runs.";
	if (!isRemoteSession()) return `${label} at ${url}.${tail}`;
	// With an advertised-URL host override the link is directly reachable
	// (e.g. over a tailnet), so the port-forwarding advice would be wrong.
	return isUrlHostOverridden()
		? `${label} — open ${url} on your device.${tail}`
		: `${label} — open ${url} on your local machine (forward the port if needed).${tail}`;
}
