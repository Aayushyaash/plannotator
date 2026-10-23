import { describe, expect, it } from "bun:test";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { ALL_TOOL_KINDS, REFUSED_KINDS, decidePermission, isBuilderToolCall, refusalResponse, vetAnswer } from "./permission-policy";

const OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Never", kind: "reject_always" },
];

function request(kind: ToolKind | null, extra: Partial<RequestPermissionRequest["toolCall"]> = {}, options = OPTIONS): RequestPermissionRequest {
  return { sessionId: "s", toolCall: { toolCallId: "t1", title: "A tool", ...(kind && { kind }), ...extra }, options };
}

describe("the read-only permission policy", () => {
  it("covers every ACP tool kind", () => {
    // The SDK's ToolKind union: a new kind must be decided here on purpose.
    expect([...ALL_TOOL_KINDS].sort()).toEqual(["delete", "edit", "execute", "fetch", "move", "other", "read", "search", "switch_mode", "think"]);
  });

  type Action = "ask" | "refuse" | "allow";
  const table: Record<ToolKind, { local: Action; pr: Action }> = {
    read: { local: "ask", pr: "ask" },
    search: { local: "ask", pr: "ask" },
    think: { local: "ask", pr: "ask" },
    fetch: { local: "ask", pr: "refuse" },
    edit: { local: "refuse", pr: "refuse" },
    delete: { local: "refuse", pr: "refuse" },
    move: { local: "refuse", pr: "refuse" },
    execute: { local: "refuse", pr: "refuse" },
    switch_mode: { local: "refuse", pr: "refuse" },
    other: { local: "ask", pr: "ask" },
  };
  for (const kind of ALL_TOOL_KINDS) {
    for (const run of ["local", "pr"] as const) {
      it(`${kind} in a ${run} run: ${table[kind][run]}`, () => {
        expect(decidePermission(request(kind), { run }).action).toBe(table[kind][run]);
      });
    }
  }

  it("refuses every kind that changes files or runs commands", () => {
    expect([...REFUSED_KINDS].sort()).toEqual(["delete", "edit", "execute", "move", "switch_mode"]);
  });

  it("uses the kind from the earlier tool_call update when the request leaves it out", () => {
    expect(decidePermission(request(null), { run: "local", knownKind: "edit" }).action).toBe("refuse");
    expect(decidePermission(request(null), { run: "local", knownKind: "read" }).action).toBe("ask");
    // The request's own kind wins.
    expect(decidePermission(request("execute"), { run: "local", knownKind: "read" }).action).toBe("refuse");
  });

  it("asks with allow once and reject only: never 'always allow'", () => {
    const d = decidePermission(request("read"), { run: "local" });
    expect(d.action === "ask" && d.options.map((o) => o.optionId)).toEqual(["allow-once", "reject-once", "reject-always"]);
  });

  it("refuses when the agent offers no once-only allow", () => {
    const d = decidePermission(request("read", {}, [OPTIONS[1], OPTIONS[2]]), { run: "local" });
    expect(d.action).toBe("refuse");
  });

  it("allows the builder's own tools once without asking", () => {
    for (const t of [{ name: "guide_set_header" }, { title: "mcp__plannotator-guide__guide_finish" }, { title: "plannotator-guide.guide_place_file" }, { title: "plannotator-guide/guide_read" }, { title: "plannotator-guide_guide_add_chapter" }, { title: "guide_set_overview" }]) {
      expect(decidePermission(request("other", t), { run: "pr" })).toEqual({ action: "allow", optionId: "allow-once" });
      expect(decidePermission(request(null, t), { run: "pr" })).toEqual({ action: "allow", optionId: "allow-once" });
    }
  });

  it("never treats a command that only mentions a builder tool as one", () => {
    expect(isBuilderToolCall({ title: "echo guide_finish && rm -rf ~" })).toBe(false);
    expect(isBuilderToolCall({ title: "mcp__evil__guide_finish" })).toBe(false);
    expect(isBuilderToolCall({ title: "guide_not_a_tool" })).toBe(false);
    // A builder name on a tool of a refused kind is still refused.
    expect(decidePermission(request("execute", { name: "guide_finish" }), { run: "local" }).action).toBe("refuse");
    expect(decidePermission(request("edit", { title: "guide_finish" }), { run: "local" }).action).toBe("refuse");
  });

  it("answers a refusal with the agent's reject option, else cancelled", () => {
    expect(refusalResponse(request("edit"))).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(refusalResponse(request("edit", {}, [OPTIONS[0], OPTIONS[3]]))).toEqual({ outcome: { outcome: "selected", optionId: "reject-always" } });
    expect(refusalResponse(request("edit", {}, [OPTIONS[0], OPTIONS[1]]))).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("turns an answer outside the offered options into a refusal", () => {
    const req = request("read");
    const offered = [OPTIONS[0], OPTIONS[2]];
    expect(vetAnswer(req, offered, { outcome: { outcome: "selected", optionId: "allow-once" } })).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(vetAnswer(req, offered, { outcome: { outcome: "selected", optionId: "allow-always" } })).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(vetAnswer(req, offered, { outcome: { outcome: "cancelled" } })).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
