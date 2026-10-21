/**
 * One origin for the Inbox window.
 *
 * A browser keeps its notification permission (and cookies and storage) per
 * origin, and `http://127.0.0.1:<port>` and `http://localhost:<port>` are two
 * origins for the same server. The Inbox advertises and opens
 * `http://localhost:<port>/` (the spelling the thread links agents get, and
 * the one plan review, code review and annotate share their cookies on), so a
 * person who once allowed notifications at `127.0.0.1` got none at
 * `localhost`. A page loaded at the other loopback spelling of THIS port
 * (`127.x.y.z`, `[::1]`) is sent to the canonical one.
 *
 * Only a browser's top-level navigation to `/` is redirected (`Sec-Fetch-Mode:
 * navigate` and `Sec-Fetch-Dest: document`), so APIs, the event stream, the
 * device door, MCP, connection routes and any client without fetch metadata
 * (curl, the tests' fetches) are answered where they asked. The tailnet
 * listener never gets here (its requests carry `via: "tailnet"`), and any name
 * that is not a loopback literal (`inbox.plannotator.localhost`, a
 * `PLANNOTATOR_ALLOWED_HOSTS` name) is left alone, so a proxy that rewrites
 * Host to a name never loops. The fragment (`#thread=…`) is kept by the
 * browser across the redirect; the query is carried in `Location`. 307 and
 * `no-store`: never cached, since another server may hold this port later.
 */

import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";

/** The one spelling the Inbox opens, advertises and redirects to. */
export const INBOX_CANONICAL_HOSTNAME = "localhost";

/** `http://localhost:<port>/`: the Inbox's one address on this computer. */
export function inboxCanonicalBaseUrl(port: number): string {
  return `http://${INBOX_CANONICAL_HOSTNAME}:${port}/`;
}

/**
 * The redirect for a top-level navigation of `/` that reached this port by a
 * loopback literal (`127.x.y.z`, `[::1]`), or null to answer the request as it is.
 */
export function inboxCanonicalRedirect(req: Request, url: URL, port: number, via: "local" | "tailnet"): Response | null {
  if (via !== "local") return null;
  if (req.method !== "GET" || url.pathname !== "/") return null;
  if (req.headers.get("sec-fetch-mode") !== "navigate" || req.headers.get("sec-fetch-dest") !== "document") return null;
  const host = req.headers.get("host");
  if (!host || !isLoopbackHostHeader(host, port)) return null;
  const target = inboxCanonicalBaseUrl(port);
  if (new URL(target).host === host.trim().toLowerCase()) return null;
  return new Response(null, {
    status: 307,
    headers: {
      Location: `${target}${url.search}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
