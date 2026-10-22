/**
 * The Inbox's `:::action` blocks (approval "inbox-next-actions"). Failures to
 * catch: an action item's grammar leaking into plan review's question grammar; a
 * `Stopped: no` or `Holds up: none` read as a stop; a `javascript:` Where
 * becoming a button; a code fence hiding no block; keys that move when the why
 * changes; the reply the agent gets drifting from the brief.
 */
import { describe, expect, test } from "bun:test";
import {
  checkInboxActionResult,
  composeInboxActionsReply,
  inboxActionsStillOpenLine,
  inboxActionKey,
  INBOX_ACTION_EXAMPLE,
  parseInboxActionBlocks,
  parseInboxActionWhere,
  parseInboxDoneRef,
} from "./inbox-actions";
import { findQuestionBlocks, indexQuestionBlocks, parseQuestionBlock, isQuestionDirectiveKind } from "./question-block";
import { composeInboxReplyBody, composeInboxSetAsideBody, inboxQuestionState, parseInboxQuestionBlocks, parseInboxSupersedeRef, summarizeInboxQuestions } from "./inbox-questions";
import { readInboxQuestionKind, type InboxQuestion, type InboxQuestionRecord } from "./inbox-types";

const BODY = [
  "The deploy is ready.",
  "",
  INBOX_ACTION_EXAMPLE,
  "",
  ":::action",
  "Run: `npm login`",
  "Sign in to npm in your terminal",
  "The publish failed with E401.",
  "Stopped: no",
  "Holds up: none; the 4.2 publish",
  ":::",
].join("\n");

describe("parseInboxActionBlocks", () => {
  test("the first line is the action item, labelled lines are read, the rest is the why", () => {
    const [deploy, npm] = parseInboxActionBlocks(BODY);
    expect(deploy).toMatchObject({
      key: inboxActionKey("Approve the production deploy on Vercel"),
      position: 0,
      prompt: "Approve the production deploy on Vercel",
      why: 'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
      action: {
        where: "vercel.com",
        where_url: "https://vercel.com/acme/web/deployments",
        run: null,
        watching: "the deployment; I go on by myself once it is Ready",
      },
      stopped: "release 4.2 cannot go out until it is approved",
      holds_up: [],
      startLine: 3,
      line: 4,
    });
    // A Run: line before the order is still a label; the negative-word guard holds for action items too.
    expect(npm).toMatchObject({ prompt: "Sign in to npm in your terminal", position: 1, why: "The publish failed with E401.", stopped: null, holds_up: ["the 4.2 publish"] });
    expect(npm!.action.run).toBe("npm login");
    expect(deploy!.key).toMatch(/^a-[0-9a-f]{8}$/);
  });

  test("the key follows the first line only: the why may change, a reworded action item is a new one; repeats get -2", () => {
    const a = parseInboxActionBlocks(":::action\nTouch your YubiKey\nfor the signing step\n:::")[0]!;
    const b = parseInboxActionBlocks(":::action\n**Touch your yubikey.**\nanother why\n:::")[0]!;
    expect(b.key).toBe(a.key);
    const twice = parseInboxActionBlocks(":::action\nTouch your YubiKey\n:::\n\n:::action\nTouch your YubiKey\n:::");
    expect(twice.map((x) => x.key)).toEqual([a.key, `${a.key}-2`]);
    expect(parseInboxActionBlocks(":::action\nTouch your YubiKey again\n:::")[0]!.key).not.toBe(a.key);
  });

  test("a block in a code fence, an empty block, or one with only labels is no action item", () => {
    expect(parseInboxActionBlocks("```\n:::action\nApprove it\n:::\n```")).toEqual([]);
    expect(parseInboxActionBlocks(":::action\n:::")).toEqual([]);
    expect(parseInboxActionBlocks(":::action\nWhere: https://x.test\n:::")).toEqual([]);
    expect(parseInboxActionBlocks("no blocks here")).toEqual([]);
  });

  test("Where: a link with a name, a bare URL, words; only http(s) becomes a button", () => {
    expect(parseInboxActionWhere("[Vercel](https://vercel.com/acme)")).toEqual({ where: "Vercel", where_url: "https://vercel.com/acme" });
    expect(parseInboxActionWhere("Stripe dashboard https://dashboard.stripe.com/apikeys")).toEqual({ where: "Stripe dashboard", where_url: "https://dashboard.stripe.com/apikeys" });
    expect(parseInboxActionWhere("<https://github.com/acme/web/pull/12>")).toEqual({ where: "github.com", where_url: "https://github.com/acme/web/pull/12" });
    expect(parseInboxActionWhere("the YubiKey on your desk")).toEqual({ where: "the YubiKey on your desk", where_url: null });
    expect(parseInboxActionWhere("[click](javascript:alert(1))")).toEqual({ where: "click", where_url: null });
    expect(parseInboxActionWhere("javascript:alert(1)").where_url).toBeNull();
  });

  test("Replaces: ids are read only when every token is an id; prose stays in the why", () => {
    const id = "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0";
    const [block] = parseInboxActionBlocks(`:::action\nApprove the deploy\nReplaces: ${id}\n:::`);
    expect(block!.replaces).toEqual([id]);
    expect(block!.why).toBeNull();
    // An action item replaces only an action item: a question's id on its Replaces: line is prose.
    const [questionId] = parseInboxActionBlocks(":::action\nApprove the deploy\nReplaces: msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/q-4f2c19e0\n:::");
    expect(questionId!.replaces).toEqual([]);
    const [prose] = parseInboxActionBlocks(":::action\nApprove the deploy\nReplaces: the manual promote step\n:::");
    expect(prose!.replaces).toEqual([]);
    expect(prose!.why).toBe("Replaces: the manual promote step");
  });
});

describe("plan review's question grammar is unchanged", () => {
  test("`:::action` is not a question kind, the question reader ignores it, and question keys stay q-", () => {
    expect(isQuestionDirectiveKind("action")).toBe(false);
    expect(parseQuestionBlock("action", "Approve it")).toBeNull();
    expect(findQuestionBlocks(BODY)).toEqual([]);
    expect(parseInboxQuestionBlocks(BODY)).toEqual([]);
    const mixed = `${BODY}\n\n:::question\nShip on Friday?\n\n- [ ] Yes\n- [ ] No\n:::`;
    const questions = findQuestionBlocks(mixed);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.key).toMatch(/^q-/);
    expect(indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "action", content: "Approve it", startLine: 1 }])).toEqual([]);
  });
});

const record = (over: Partial<InboxQuestionRecord>): InboxQuestionRecord => ({
  id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-00000001",
  project_id: "prj_x",
  message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE",
  key: "a-00000001",
  position: 0,
  kind: "action",
  prompt: "Approve the production deploy on Vercel",
  parsed: { context: null, choices: [], aliases: [], recommendation: null, suggested_text: null, line: 2 },
  stopped: null,
  holds_up: [],
  asked_by_agent_id: "ses_a",
  answer: null,
  revision: 0,
  sent_revision: 0,
  picked_by: null,
  picked_at: null,
  sent_reply_id: null,
  action: { where: null, where_url: null, run: null, watching: null },
  action_result: null,
  ...over,
});

describe("an action item's state", () => {
  test("open, then picked inside the Undo window, then sent; the agent's own done closes it", () => {
    expect(inboxQuestionState(record({}), false)).toBe("open");
    const marked = record({ revision: 1, action_result: { outcome: "done", note: null, at: "2026-10-21T15:12:00.000Z", by: "person" } });
    expect(inboxQuestionState(marked, false)).toBe("picked");
    expect(inboxQuestionState({ ...marked, sent_revision: 1, sent_reply_id: "msg_x" }, false)).toBe("sent");
    expect(inboxQuestionState(record({ revision: 1, action_result: { outcome: "done", note: null, at: "x", by: "agent", message_id: "m" } }), false)).toBe("closed");
  });

  test("the row counts an open action item like a question, and says how many are action items; one in its Undo window waits on nobody", () => {
    const wire = (r: InboxQuestionRecord, state: InboxQuestion["state"]) => ({ ...r, state, orphaned: false, kind: r.kind }) as unknown as InboxQuestion;
    const summary = summarizeInboxQuestions([
      wire(record({ stopped: "release 4.2" }), "open"),
      wire(record({ kind: "single", key: "q-1" }), "open"),
      wire(record({ key: "a-2" }), "picked"),
    ]);
    expect(summary).toMatchObject({ open: 2, picked: 0, stopped: true, actions: 1 });
  });

  test("the kind is read fail-closed: a kind this build does not know is not answerable", () => {
    expect(readInboxQuestionKind("action")).toBe("action");
    expect(readInboxQuestionKind("single")).toBe("single");
    expect(readInboxQuestionKind("checklist")).toBe("unknown");
    expect(readInboxQuestionKind(undefined)).toBe("unknown");
  });
});

describe("what the agent gets", () => {
  test("the reply's section, exactly as the brief has it", () => {
    const done = record({ revision: 1, action_result: { outcome: "done", note: "Approved. I also fixed the preview env var while I was there.", at: "2026-10-21T15:12:00.000Z", by: "person" } });
    expect(composeInboxActionsReply({ reported: [done], all: [done], timeZone: "UTC" })).toBe(
      [
        "Did 1 action item.",
        "",
        "## Action items you asked for",
        "",
        "1 of 1 done.",
        "",
        "### A1. Approve the production deploy on Vercel",
        "Done, 3:12 PM.",
        "Note: Approved. I also fixed the preview env var while I was there.",
      ].join("\n"),
    );
  });

  test("Can't do it: the reason word for word; mixed outcomes count both", () => {
    const cant = record({ key: "a-2", position: 1, prompt: "Merge PR #12", revision: 1, action_result: { outcome: "cant", note: "I'm not in the acme team; ask Dana.", at: "2026-10-21T15:13:00.000Z", by: "person" } });
    const done = record({ revision: 1, action_result: { outcome: "done", note: null, at: "2026-10-21T15:12:00.000Z", by: "person" } });
    const body = composeInboxActionsReply({ reported: [cant, done], all: [done, cant], timeZone: "UTC" });
    expect(body.split("\n")[0]).toBe("Did 1 action item, couldn't do 1.");
    expect(body).toContain("1 of 2 done.");
    expect(body).toContain("### A2. Merge PR #12\nCan't do it: I'm not in the acme team; ask Dana.");
    expect(body.indexOf("### A1.")).toBeLessThan(body.indexOf("### A2."));
  });

  test("the still-open line names what of that message still waits, like the reply's still-open line", () => {
    expect(inboxActionsStillOpenLine([])).toBe("");
    expect(inboxActionsStillOpenLine([{ kind: "action", position: 1, prompt: "Approve the 2FA prompt for the npm org" }])).toBe(
      "Still open: A2. Approve the 2FA prompt for the npm org — the person will do it in the Inbox; don't ask again.",
    );
    expect(
      inboxActionsStillOpenLine([
        { kind: "action", position: 1, prompt: "Approve the 2FA prompt" },
        { kind: "question", position: 0, prompt: "Publish as latest?" },
      ]),
    ).toBe("Still open: Q1. Publish as latest?; A2. Approve the 2FA prompt — the person will answer or do them in the Inbox; don't ask again.");
    expect(inboxActionsStillOpenLine([{ kind: "question", position: 0, prompt: "Publish as latest?" }, { kind: "question", position: 1, prompt: "Tag it?" }])).toBe(
      "Still open: Q1. Publish as latest?; Q2. Tag it? — the person will answer them in the Inbox; don't ask again.",
    );
    const cant = record({ revision: 1, action_result: { outcome: "cant", note: "No key.", at: "2026-10-21T15:12:00.000Z", by: "person" } });
    const body = composeInboxActionsReply({ reported: [cant], all: [cant, record({ key: "a-2", position: 1 })], stillOpen: [{ kind: "action", position: 1, prompt: "Merge PR #12" }], timeZone: "UTC" });
    expect(body.endsWith("Can't do it: No key.\n\nStill open: A2. Merge PR #12 — the person will do it in the Inbox; don't ask again.")).toBe(true);
    expect(body).toContain("0 of 2 done.");
  });

  test("a reply's question sections never count or number an action item", () => {
    const question = record({ kind: "single", key: "q-11111111", prompt: "Ship on Friday?", parsed: { context: null, choices: [{ label: "Yes", description: null, recommended: false, settled: false }], aliases: [null], recommendation: null, suggested_text: null, line: 2 } });
    const body = composeInboxReplyBody({ questions: [], sent: [], earlier: [], words: "Thanks.", stillOpen: [question, record({})] });
    expect(body).toBe("Thanks.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.");
  });

  test("Mark read's note lists action items as A1 after the questions", () => {
    expect(composeInboxSetAsideBody([record({ position: 0 }), { ...record({ kind: "single", position: 0 }), prompt: "Ship on Friday?" }])).toContain("- Q1. Ship on Friday?\n- A1. Approve the production deploy on Vercel");
  });
});

describe("ids", () => {
  test("done takes an action item's id; supersedes takes a question's or an action item's", () => {
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: "a-4f2c19e0" });
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: null });
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/q-4f2c19e0")).toBeNull();
    expect(parseInboxSupersedeRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: "a-4f2c19e0" });
  });

  test("the person's result: Can't do it needs a reason, a note is capped, null is the Undo", () => {
    expect(checkInboxActionResult({ outcome: "done" })).toEqual({ ok: true, outcome: "done", note: null });
    expect(checkInboxActionResult({ outcome: "cant", note: "  " })).toMatchObject({ ok: false, field: "note" });
    expect(checkInboxActionResult({ outcome: "maybe" })).toMatchObject({ ok: false, field: "outcome" });
    expect(checkInboxActionResult({ outcome: null })).toEqual({ ok: true, outcome: null, note: null });
    expect(checkInboxActionResult({ outcome: "done", note: "x".repeat(2001) })).toMatchObject({ ok: false });
  });
});
