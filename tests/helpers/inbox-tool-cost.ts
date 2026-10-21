/**
 * The `plannotator_inbox` tool's cost on a host, as the window states it
 * (INBOX_TOOL_COST in packages/core/inbox-types.ts), checked against what
 * the REAL host sends the model: the tool's entry in the request body, in
 * bytes. The window's number may not drift from the measured one by more
 * than 5%; when the tool's text changes, measure again and update the
 * constant (bytes, and tokens counted from the same request).
 */
import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { INBOX_TOOL_COST, type InboxToolCostHost } from "../../packages/core/inbox-types";

export function expectMeasuredCost(host: InboxToolCostHost, entry: string): void {
  const bytes = Buffer.byteLength(entry);
  // INBOX_TOOL_COST_DUMP=<dir> keeps the entry as sent, to count its tokens when the constant is updated.
  if (process.env.INBOX_TOOL_COST_DUMP) writeFileSync(`${process.env.INBOX_TOOL_COST_DUMP}/${host}.json`, entry);
  const stated = INBOX_TOOL_COST[host];
  console.log(`[inbox tool cost] ${host}: measured ${bytes} bytes; the window states ${stated.bytes} bytes, about ${stated.tokens} tokens`);
  expect(Math.abs(bytes - stated.bytes) / stated.bytes).toBeLessThanOrEqual(0.05);
}
