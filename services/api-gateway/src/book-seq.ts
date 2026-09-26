import { randomUUID } from "node:crypto";

// Lost-event detection for the engine's book (owner, 2026-09-26). With the book idle the engine reloads its SL / TP
// levels and margin book only every 10 minutes and otherwise relies on the web's book-change events, so it must be
// able to tell when one never arrived. Every web event passes through POST /internal/events here (a single process),
// so this is where they are numbered: each book-change event (subject order.* / position.* / account.* /
// config.changed) carries `book_epoch` (random per gateway boot) and `book_seq` (+1 per event) in its payload, and the
// same pair is repeated on ONE subject, `book.seq`, which the engine reads in publish order (a single subscription)
// and checks for gaps (engine market_data::book_events). Additive fields: every other consumer ignores them.

export const BOOK_SEQ_SUBJECT = "book.seq";

export function isBookSubject(subject: string): boolean {
  return subject.startsWith("order.") || subject.startsWith("position.") || subject.startsWith("account.") || subject === "config.changed";
}

export type BookSeqState = { epoch: string; seq: number };

export function newBookSeqState(): BookSeqState {
  return { epoch: randomUUID(), seq: 0 };
}

/** The payload to publish on `subject`, and the `book.seq` marker to publish after it (null for other subjects). */
export function stampBookEvent(
  state: BookSeqState,
  subject: string,
  payload: Record<string, unknown>
): { payload: Record<string, unknown>; marker: { book_epoch: string; book_seq: number; subject: string } | null } {
  if (!isBookSubject(subject)) return { payload, marker: null };
  state.seq += 1;
  const stamp = { book_epoch: state.epoch, book_seq: state.seq };
  return { payload: { ...payload, ...stamp }, marker: { ...stamp, subject } };
}
