/**
 * `plannotator:session-opened` and `plannotator:session-closed` (#1589): one
 * event when a review opens in the browser and one when it ends, for every Pi
 * review whatever opened it (the /plannotator-* commands, the `plannotator`
 * tool, plan review, and `plannotator:request`). Tools such as Herdr show
 * "needs review" on the agent's pane between the two.
 *
 * Cache safety: these go on `pi.events` (the extension event bus) and nowhere
 * else. Nothing here writes to the conversation, the system prompt or the
 * tool list, so the model's request prefix is the same with or without them
 * (proved in session-events.test.ts).
 *
 * Stale runtimes (#1864): a review often ends after the extension instance
 * that opened it was replaced (/reload, /resume, /new). That instance's
 * `pi.events.emit` then throws Pi's stale-ctx error synchronously, and an
 * escape from an HTTP handler or timer ends the Pi process. So every emit runs
 * on a microtask, inside try/catch, and goes to a bus that is live: the
 * opener's while its session lives, else the latest instance that claimed the
 * process-wide slot below, else nowhere (dropped quietly, as
 * `plannotator:review-result` is after a replacement).
 */
import { randomBytes } from "node:crypto";

export const PLANNOTATOR_SESSION_OPENED_CHANNEL = "plannotator:session-opened" as const;
export const PLANNOTATOR_SESSION_CLOSED_CHANNEL = "plannotator:session-closed" as const;

/** What kind of review is open. Same names as the `plannotator:request` actions. */
export type PlannotatorSessionAction = "plan-review" | "code-review" | "annotate" | "annotate-last";

export interface PlannotatorSessionOpenedEvent {
	/**
	 * `pn-` + 6 hex, unique among the open reviews: pairs the two events. For
	 * a review the slash commands, the tool or plan mode opened it is the id
	 * the `plannotator` tool's list and the decision heading name.
	 */
	id: string;
	action: PlannotatorSessionAction;
	/** The review's URL (local, or the advertised remote URL). */
	url: string;
	/** `Date.now()` when the review opened. */
	openedAt: number;
	/** The Pi session that opened it (`ctx.sessionManager.getSessionId()`), when known. */
	piSessionId?: string;
	/** A `plannotator:request` plan review's `reviewId` (what `review-status` takes). */
	reviewId?: string;
	/** The `requestId` of the `plannotator:request` that opened it. */
	requestId?: string;
}

export type PlannotatorSessionOutcome = "approved" | "submitted" | "closed";

/** Who or what ended a review that closed without a decision. */
export type PlannotatorSessionClosedBy = "reviewer" | "agent" | "stopped" | "error";

export interface PlannotatorSessionClosedEvent extends PlannotatorSessionOpenedEvent {
	/**
	 * `approved`: the reviewer approved. `submitted`: the reviewer sent a
	 * decision that is not an approval (feedback, a denied plan, Done).
	 * `closed`: no decision (see `closedBy`).
	 */
	outcome: PlannotatorSessionOutcome;
	/** Present only when `outcome` is `closed`. */
	closedBy?: PlannotatorSessionClosedBy;
	/** `Date.now()` when the review ended. */
	closedAt: number;
}

/** The part of `pi` this module uses: the event bus. */
interface EventBusOwner {
	events: { emit: (channel: string, data: unknown) => void };
}

interface LiveBusSlot {
	owner: EventBusOwner | null;
}

/**
 * Versioned: an extension of another Plannotator version loaded into the same
 * process must never read a slot shaped differently.
 */
const SLOT_KEY = "__plannotatorPiSessionEventBus_v1";

function slot(): LiveBusSlot {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = store[SLOT_KEY];
	if (typeof existing === "object" && existing !== null && "owner" in existing) return existing as LiveBusSlot;
	const created: LiveBusSlot = { owner: null };
	store[SLOT_KEY] = created;
	return created;
}

/** The live extension instance's bus receives events for reviews whose opener was replaced. Call at session start. */
export function claimSessionEventBus(pi: EventBusOwner): void {
	slot().owner = pi;
}

/** At session end: the instance stops receiving them (only when it still holds the slot). */
export function releaseSessionEventBus(pi: EventBusOwner): void {
	const current = slot();
	if (current.owner === pi) current.owner = null;
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function liveNow(isLive: () => boolean): boolean {
	try {
		return isLive();
	} catch {
		return false;
	}
}

/**
 * Emit on a microtask, through the opener when its session lived at the
 * moment of the call, else (or when that emit throws) the live instance.
 * Never throws.
 */
function emitSafely(opener: EventBusOwner, useOpener: boolean, channel: string, payload: object): void {
	queueMicrotask(() => {
		if (useOpener) {
			try {
				opener.events.emit(channel, payload);
				return;
			} catch (err) {
				// The opener went stale without its session_shutdown (Pi tore it
				// down another way). Pi's bus throws only before it delivers,
				// never for a listener's own error, so the fallback below never
				// delivers twice.
				console.error(`Plannotator: could not emit ${channel}: ${describeError(err)}`);
			}
		}
		const current = slot();
		const live = current.owner;
		if (!live || live === opener) return;
		try {
			live.events.emit(channel, payload);
		} catch {
			// That instance was torn down without releasing the slot: it is
			// no live bus, so forget it. Quiet, like any emit with no live bus.
			if (current.owner === live) current.owner = null;
		}
	});
}

/**
 * The ids of every review announced and not yet closed, in this process
 * (every extension instance). Versioned like the slot.
 */
const OPEN_IDS_KEY = "__plannotatorPiSessionEventOpenIds_v1";

function openIds(): Set<string> {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = store[OPEN_IDS_KEY];
	if (existing instanceof Set) return existing as Set<string>;
	const created = new Set<string>();
	store[OPEN_IDS_KEY] = created;
	return created;
}

/** Whether an announced review still holds `id` (not yet closed). */
export function isSessionEventIdOpen(id: string): boolean {
	return openIds().has(id);
}

/**
 * A fresh `pn-` id for a review the registry does not track
 * (`plannotator:request`), unique among the open reviews: never an id an
 * announced review still holds, nor one `taken` names (the caller passes the
 * process registry's open ids). Tries the next value on a clash, as the
 * registry does.
 */
export function newSessionEventId(
	taken: (id: string) => boolean = () => false,
	randomHex: () => string = () => randomBytes(3).toString("hex"),
): string {
	const open = openIds();
	let value = Number.parseInt(randomHex(), 16) || 0;
	for (let attempt = 0; attempt < 0x1000000; attempt += 1) {
		const id = `pn-${value.toString(16).padStart(6, "0")}`;
		let clash = open.has(id);
		if (!clash) {
			try {
				clash = taken(id);
			} catch {
				clash = false;
			}
		}
		if (!clash) return id;
		value = (value + 1) % 0x1000000;
	}
	// Every id is open: cannot happen in practice (16.7 million reviews).
	return `pn-${randomBytes(3).toString("hex")}`;
}

export interface SessionEventHandle {
	readonly event: PlannotatorSessionOpenedEvent;
	/** Emit `plannotator:session-closed` (once: later calls do nothing). */
	close(end: { outcome: PlannotatorSessionOutcome; closedBy?: PlannotatorSessionClosedBy }): void;
}

/**
 * Emit `plannotator:session-opened` for a review that just opened and return
 * the handle that closes it. `isLive` says whether the opener's session still
 * lives (its `pi` is usable); it is read when each event is sent (open,
 * close), so a review closed during the opener's own session_shutdown still
 * goes out through the opener.
 */
export function openSessionEvent(
	pi: EventBusOwner,
	isLive: () => boolean,
	identity: Omit<PlannotatorSessionOpenedEvent, "openedAt"> & { openedAt?: number },
): SessionEventHandle {
	const event: PlannotatorSessionOpenedEvent = {
		id: identity.id,
		action: identity.action,
		url: identity.url,
		openedAt: identity.openedAt ?? Date.now(),
		...(identity.piSessionId ? { piSessionId: identity.piSessionId } : {}),
		...(identity.reviewId ? { reviewId: identity.reviewId } : {}),
		...(identity.requestId ? { requestId: identity.requestId } : {}),
	};
	openIds().add(event.id);
	emitSafely(pi, liveNow(isLive), PLANNOTATOR_SESSION_OPENED_CHANNEL, { ...event });
	let closed = false;
	return {
		event,
		close(end) {
			if (closed) return;
			closed = true;
			openIds().delete(event.id);
			const closedEvent: PlannotatorSessionClosedEvent = {
				...event,
				outcome: end.outcome,
				...(end.outcome === "closed" ? { closedBy: end.closedBy ?? "reviewer" } : {}),
				closedAt: Date.now(),
			};
			emitSafely(pi, liveNow(isLive), PLANNOTATOR_SESSION_CLOSED_CHANNEL, closedEvent);
		},
	};
}

/** How a review's decision ends it, for `plannotator:session-closed`. */
export function sessionEndOf(result: {
	approved?: boolean;
	exit?: boolean;
	closedBy?: string;
} | null | undefined): { outcome: PlannotatorSessionOutcome; closedBy?: PlannotatorSessionClosedBy } {
	if (result?.closedBy === "agent") return { outcome: "closed", closedBy: "agent" };
	if (result?.exit) return { outcome: "closed", closedBy: "reviewer" };
	if (result?.approved) return { outcome: "approved" };
	return { outcome: "submitted" };
}

/** A review whose decision promise rejected: stopped on purpose, or failed. */
export function sessionEndOfError(stopped: boolean): { outcome: "closed"; closedBy: PlannotatorSessionClosedBy } {
	return { outcome: "closed", closedBy: stopped ? "stopped" : "error" };
}
