import { describe, expect, test } from "bun:test";
import { buildDecisionSpec } from "@plannotator/ui/utils/decisionSpec";
import { resolvePlanDecisionAction } from "./planDecision";

describe("resolvePlanDecisionAction (#1057)", () => {
  // What regresses: a menu row that posts to the wrong endpoint, e.g. the
  // discard confirm still carrying the comments as notes (an "approved with
  // notes" turn the reviewer chose to drop), or a note on a deny route
  // reaching the agent as an approval.
  test("each id goes to the transport its row promises", () => {
    expect(resolvePlanDecisionAction("primary")).toEqual({ kind: "primary" });
    expect(resolvePlanDecisionAction("request-changes")).toEqual({ kind: "note", route: "deny" });
    expect(resolvePlanDecisionAction("note-with-feedback")).toEqual({ kind: "note", route: "deny" });
    expect(resolvePlanDecisionAction("note-with-approval")).toEqual({ kind: "note", route: "approve" });
    expect(resolvePlanDecisionAction("approve-with-notes")).toEqual({ kind: "approve", discardFeedback: false });
    expect(resolvePlanDecisionAction("discard-and-finish")).toEqual({ kind: "approve", discardFeedback: true });
  });

  // Every id the plan arm can emit has a route (a new spec id without one
  // would be a dead row).
  test("every id the plan spec emits resolves", () => {
    for (const hasFeedback of [false, true])
      for (const approvalNotesSupported of [false, true]) {
        const spec = buildDecisionSpec({
          app: "plan", gate: true, count: hasFeedback ? 2 : 0, hasFeedback, approvalNotesSupported,
        });
        for (const id of [spec.primary.id, ...spec.items.map((item) => item.id)]) {
          expect(resolvePlanDecisionAction(id)).toBeDefined();
        }
      }
  });
});
