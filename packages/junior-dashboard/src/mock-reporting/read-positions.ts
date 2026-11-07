import type {
  ConversationDetailReport,
  ConversationReadPosition,
} from "@sentry/junior/api/schema";
import {
  readMockConversationDetail,
  setMockConversationUnread,
} from "./fixtures";

/** Process-local read positions so mock QA can reopen at unread rows. */
const mockReadPositions = new Map<string, number>();

/** Clear mock read positions so tests sharing a worker do not leak state. */
export function resetMockReadPositions(): void {
  mockReadPositions.clear();
}

/** Junior's latest reply that the transcript shows, as the API counts it. */
function latestVisibleReplySeq(conversationId: string): number | undefined {
  const events = readMockConversationDetail(conversationId)?.events ?? [];
  return events
    .filter(
      (event) =>
        event.data.type === "message" &&
        event.data.role === "assistant" &&
        event.data.quiet !== true,
    )
    .at(-1)?.seq;
}

/**
 * Move a mock read position forward, like the API. Reading through Junior's
 * latest visible reply also clears the feed's unread flag.
 */
export function markMockConversationRead(
  conversationId: string,
  lastReadSeq: number,
): ConversationReadPosition | undefined {
  const detail = readMockConversationDetail(conversationId);
  if (!detail) return undefined;
  const lastSeq = detail.events.at(-1)?.seq ?? 0;
  const stored = Math.max(
    mockReadPositions.get(conversationId) ?? -1,
    Math.min(lastReadSeq, lastSeq),
  );
  mockReadPositions.set(conversationId, stored);
  const replySeq = latestVisibleReplySeq(conversationId);
  if (replySeq !== undefined && stored >= replySeq) {
    setMockConversationUnread(conversationId, false);
  }
  return { lastReadSeq: stored };
}

/**
 * Mark one mock conversation read or unread, like the API: read moves the
 * position to the last event, unread moves it back just before Junior's
 * latest visible reply.
 */
export function setMockConversationReadState(
  conversationId: string,
  unread: boolean,
): ConversationReadPosition | undefined {
  if (!unread) {
    return markMockConversationRead(conversationId, Number.MAX_SAFE_INTEGER);
  }
  const replySeq = latestVisibleReplySeq(conversationId);
  if (
    replySeq === undefined ||
    !setMockConversationUnread(conversationId, true)
  ) {
    return undefined;
  }
  const lastReadSeq = Math.max(replySeq - 1, 0);
  mockReadPositions.set(conversationId, lastReadSeq);
  return { lastReadSeq };
}

/** Add the mock read position to a detail report. */
export function withMockReadPosition(
  report: ConversationDetailReport,
): ConversationDetailReport {
  const lastReadSeq = mockReadPositions.get(report.conversationId);
  return lastReadSeq === undefined
    ? report
    : { ...report, readPosition: { lastReadSeq } };
}
