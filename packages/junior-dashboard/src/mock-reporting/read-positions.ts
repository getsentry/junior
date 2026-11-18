import type {
  ConversationDetailReport,
  ConversationReadPosition,
} from "@sentry/junior/api/schema";
import { readMockConversationDetail } from "./fixtures";

/** Process-local read positions so mock QA can reopen at unread rows. */
const mockReadPositions = new Map<string, number>();

/** Clear mock read positions so tests sharing a worker do not leak state. */
export function resetMockReadPositions(): void {
  mockReadPositions.clear();
}

/** Move a mock read position forward, like the API. */
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
  return { lastReadSeq: stored };
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
