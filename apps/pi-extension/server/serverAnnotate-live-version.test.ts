/**
 * Pi annotate server: a disk change becomes a version (#2037). Same
 * scenarios as the Bun server
 * (packages/server/annotate-live-version.scenarios.ts), so the mirror cannot
 * drift.
 */
import { defineAnnotateLiveVersionScenarios } from "../../../packages/server/annotate-live-version.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineAnnotateLiveVersionScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
});
