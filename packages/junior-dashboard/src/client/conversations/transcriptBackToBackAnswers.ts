import { createContext } from "react";

import { reviewItemIdFromToolCall } from "../review-desk/reviewItemFormat";
import type { TranscriptListRow } from "./transcriptListRows";

/**
 * Return the ids of the Review items whose answer row comes directly after
 * the row that asked them. These two rows show as one question and its
 * answer, so the answer does not repeat the question and the question does
 * not repeat the answer.
 */
export function backToBackAnswerItemIds(
  rows: readonly TranscriptListRow[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const ask = rows[index - 1]!;
    const answer = rows[index]!;
    if (ask.kind !== "entry" || answer.kind !== "entry") continue;
    if (ask.entry.kind !== "tool" || answer.entry.kind !== "message") continue;
    const itemId = reviewItemIdFromToolCall(ask.entry.part);
    if (itemId === undefined) continue;
    // An Event message relays a change from somewhere else, not an answer
    // to the question above it.
    const { message } = answer.entry;
    if (message.eventType) continue;
    const answered = message.reviewItemChanges?.some(
      (change) => change.kind === "submitted" && change.reviewItemId === itemId,
    );
    if (answered) ids.add(itemId);
  }
  return ids;
}

/** The Review items of the transcript list that are answered back to back. */
export const TranscriptBackToBackAnswers = createContext<ReadonlySet<string>>(
  new Set(),
);
