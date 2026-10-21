import type { DecisionActionId } from "@plannotator/ui/utils/decisionSpec";

/**
 * Pure transport routing for the plan-review decision control (#1057).
 *
 * `buildDecisionSpec({ app: 'plan' })` decides what the header offers; this
 * decides where each choice goes, on plan review's two existing transports
 * and nothing else: `/api/deny` (feedback, answers-only when the only
 * feedback is answers) and `/api/approve` (with the session's feedback as
 * notes, or bare). Kept pure so the exhaustive switch below fails the build
 * when the spec gains an id without a route.
 */
export type PlanDecisionRoute =
  /** The visible primary: approve when nothing is ready, else deny. */
  | { kind: "primary" }
  /** Commit the note as a GLOBAL_COMMENT, then submit on the next render
   *  (the annotate mechanism, #1436). `deny` sends it as feedback; `approve`
   *  sends it as the approval's notes (only offered where delivered). */
  | { kind: "note"; route: "deny" | "approve" }
  /** /api/approve. `discardFeedback` omits `feedback` from the body: the
   *  confirmed "Approve, discard …" row. Otherwise the session's feedback
   *  rides along, exactly as plan Approve always sent it. */
  | { kind: "approve"; discardFeedback: boolean };

export function resolvePlanDecisionAction(id: DecisionActionId): PlanDecisionRoute {
  switch (id) {
    case "primary":
      return { kind: "primary" };
    case "note-with-approval":
      return { kind: "note", route: "approve" };
    case "request-changes":
    case "note-with-feedback":
      return { kind: "note", route: "deny" };
    case "approve-with-notes":
      return { kind: "approve", discardFeedback: false };
    case "discard-and-finish":
      return { kind: "approve", discardFeedback: true };
  }
}
