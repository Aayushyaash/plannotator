/**
 * Bun annotate server: a disk change becomes a version (#2037). The
 * scenarios are shared with the Pi mirror, see
 * annotate-live-version.scenarios.ts.
 */
import { defineAnnotateLiveVersionScenarios } from "./annotate-live-version.scenarios";
import { startAnnotateServer } from "./annotate";

defineAnnotateLiveVersionScenarios("bun", async (options) => {
  const server = await startAnnotateServer({
    ...options,
    htmlContent: "<html><body>Plannotator</body></html>",
  });
  return { url: server.url, stop: server.stop };
});
