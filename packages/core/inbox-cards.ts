/**
 * Plannotator Inbox: the Board's cards (approval "inbox-board", 2026-10-20).
 *
 * A card is one piece of work the person asked for (or an agent took on)
 * that outlasts the reply it was asked in. It is its own record, separate
 * from threads: threads and PRs link to it by explicit id, and nothing about
 * a card ever changes a thread's routing or its place in the person's list.
 *
 * Columns (COLUMNS.md, set d): five live ones, Asked · Designing · Your look ·
 * Building · Your review, and three the Board shows as links: Shipped,
 * Icebox (only the person puts a card there) and Dropped. A card in the
 * person's columns (Your look, Your review) shows "You: …", what the person
 * owes; in the agents' columns it shows the agent's last word.
 *
 * Amber is derived, never stored: a card in a live column that has not been
 * heard from for two days. Nothing moves a card by guessing: a merged PR is
 * shown, never acted on.
 *
 * Browser-safe and dependency-free; re-exported by `inbox-types`.
 */

import type { InboxAuthor } from "./inbox-types";

/** Every column a card can be in, in the Board's order. */
export const INBOX_CARD_COLUMNS = ["asked", "designing", "your_look", "building", "your_review", "shipped", "icebox", "dropped"] as const;

export type InboxCardColumn = (typeof INBOX_CARD_COLUMNS)[number];

/** The Board's live lanes; the rest (Shipped, Icebox, Dropped) are links. */
export const INBOX_CARD_LIVE_COLUMNS: readonly InboxCardColumn[] = ["asked", "designing", "your_look", "building", "your_review"];

/** The columns where a card waits on the person: it shows "You: …" (`you`). */
export const INBOX_CARD_PERSON_COLUMNS: readonly InboxCardColumn[] = ["your_look", "your_review"];

/** How the Board names each column. */
export const INBOX_CARD_COLUMN_LABELS: Readonly<Record<InboxCardColumn, string>> = {
  asked: "Asked",
  designing: "Designing",
  your_look: "Your look",
  building: "Building",
  your_review: "Your review",
  shipped: "Shipped",
  icebox: "Icebox",
  dropped: "Dropped",
};

/** A card in a live column turns amber when nobody has been heard from for this long. */
export const INBOX_CARD_AMBER_MS = 2 * 24 * 60 * 60 * 1000;

/** The longest title, in characters. */
export const INBOX_CARD_TITLE_MAX = 120;
/** The longest one-line `say` or `you`, in characters. */
export const INBOX_CARD_LINE_MAX = 280;
/** The longest drop reason, in characters. */
export const INBOX_CARD_REASON_MAX = 500;
/** The most threads, and the most PRs, one card links. */
export const INBOX_CARD_LINKS_MAX = 50;

export function isInboxCardColumn(value: unknown): value is InboxCardColumn {
  return typeof value === "string" && (INBOX_CARD_COLUMNS as readonly string[]).includes(value);
}

export function isInboxCardLiveColumn(column: InboxCardColumn): boolean {
  return INBOX_CARD_LIVE_COLUMNS.includes(column);
}

export function isInboxCardPersonColumn(column: InboxCardColumn): boolean {
  return INBOX_CARD_PERSON_COLUMNS.includes(column);
}

/** A PR (or merge request) a card links: `ref` as people write it, `url` to open it. */
export interface InboxCardPr {
  /** `owner/repo#123` (GitHub, Bitbucket), `group/project!12` (GitLab). */
  ref: string;
  url: string;
}

/** Why a card was dropped, and who dropped it. */
export interface InboxCardDrop {
  at: string;
  by: InboxAuthor;
  /** Required from an agent, optional from the person. */
  reason: string | null;
}

/**
 * One card, as the store keeps it (`cards.jsonl`, one full snapshot per
 * line; the last line per id is current). Fields are only ever added.
 */
export interface InboxCard {
  /** `crd_` + ULID. */
  id: string;
  project_id: string;
  title: string;
  column: InboxCardColumn;
  /**
   * What the person owes, shown as "You: …" while the card is in Your look or
   * Your review. Cleared when the card leaves those columns, so a stale ask
   * never follows it back.
   */
  you: string | null;
  /** The agent's last word, shown in the agents' columns. */
  said: string | null;
  /** Thread root ids, in the order they were linked. */
  threads: string[];
  prs: InboxCardPr[];
  /**
   * The agent session the card belongs to (the one that made it): where "Ask
   * where this is" goes. Null for a card the person made. Named `agent`, not
   * `owner`: the Board's owner is the person.
   */
  agent: InboxAuthor | null;
  created_at: string;
  created_by: InboxAuthor;
  /** When the card last changed column. */
  moved_at: string;
  /** The last write by anyone (create, move, say, link, ship, drop): amber reads it. */
  heard_at: string;
  heard_by: InboxAuthor;
  /** Set while the card is in Dropped. */
  dropped: InboxCardDrop | null;
  /** The column a card left for Icebox or Dropped: where restoring puts it back. */
  aside_from: InboxCardColumn | null;
  /** An agent's create is idempotent on it, per project. */
  idempotency_key: string | null;
}

/** A card as every reader gets it: the record plus what is derived now. */
export interface InboxCardWire extends InboxCard {
  /** Not heard from for two days, in a live column (never in Shipped, Icebox or Dropped). */
  amber: boolean;
}

/** Whether a card shows amber at `nowMs`. */
export function inboxCardAmber(card: Pick<InboxCard, "column" | "heard_at">, nowMs: number): boolean {
  if (!isInboxCardLiveColumn(card.column)) return false;
  const heard = Date.parse(card.heard_at);
  return Number.isFinite(heard) && nowMs - heard >= INBOX_CARD_AMBER_MS;
}

export function inboxCardWire(card: InboxCard, nowMs: number): InboxCardWire {
  return { ...card, amber: inboxCardAmber(card, nowMs) };
}

/** The line a card shows under its title: "You: …" in the person's columns, the agent's last word otherwise. */
export function inboxCardLine(card: Pick<InboxCard, "column" | "you" | "said">): string | null {
  if (isInboxCardPersonColumn(card.column) && card.you) return `You: ${card.you}`;
  return card.said;
}

/** A sort key: the Board's column order. */
export function inboxCardColumnIndex(column: InboxCardColumn): number {
  return INBOX_CARD_COLUMNS.indexOf(column);
}

// Control characters other than whitespace, and the bidi controls (a line must read as written).
const REFUSED_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

/**
 * A card's one line of text, made one line: every run of whitespace (line
 * breaks included) becomes one space, the ends trimmed. Refused (a message,
 * not the text) when it holds a control or bidi character, is empty, or is
 * longer than `max` characters.
 */
export function normalizeInboxCardText(value: unknown, field: string, max: number): { text: string } | { error: string } {
  if (typeof value !== "string") return { error: `${field}: a string.` };
  if (REFUSED_CHARS.test(value)) return { error: `${field}: no control or bidi characters.` };
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return { error: `${field}: empty.` };
  if ([...text].length > max) return { error: `${field}: at most ${max} characters (one line).` };
  return { text };
}
