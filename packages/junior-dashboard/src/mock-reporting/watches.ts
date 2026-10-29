import type { ConversationWatchesReport } from "@sentry/junior/api/schema";
import {
  DASHBOARD_QA_CONVERSATION_ID,
  readMockConversationDetail,
} from "./fixtures";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

// Watch times are relative to the real clock, not the fixed fixture time, so
// the timer fire time stays in the future.
function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Return the active Watches of one mock Conversation. The dashboard QA
 * Conversation has one Watch of each common shape: a pull request with a
 * match filter, a deployment, a timer, a redacted Watch, and one that a child
 * agent created.
 */
export function readMockConversationWatches(
  conversationId: string,
): ConversationWatchesReport | undefined {
  if (!readMockConversationDetail(conversationId)) return undefined;
  if (conversationId !== DASHBOARD_QA_CONVERSATION_ID) {
    return { conversationId, watches: [] };
  }
  return {
    conversationId,
    watches: [
      {
        createdAt: iso(-3 * HOUR_MS),
        events: [
          "pull_request.checks.failed",
          "pull_request.review.changes_requested",
          "pull_request.merged",
        ],
        expiresAt: iso(13 * DAY_MS),
        id: "watch-pr",
        intent:
          "Fix failing checks and address requested changes on the dashboard PR.",
        label: "getsentry/junior#2383",
        namespace: "github",
        resourceType: "pull_request",
      },
      {
        createdAt: iso(-2 * HOUR_MS),
        events: ["deployment.failed", "deployment.succeeded"],
        expiresAt: iso(20 * HOUR_MS),
        id: "watch-deploy",
        intent: "Report the preview URL, or the build error if it fails.",
        label: "junior-dashboard preview",
        match: { target: "preview" },
        namespace: "vercel",
        resourceType: "deployment",
      },
      {
        createdAt: iso(-30 * 60_000),
        events: ["timer.fired"],
        expiresAt: iso(2 * HOUR_MS + 5 * 60_000),
        firesAt: iso(2 * HOUR_MS),
        id: "watch-timer",
        intent: "Check whether CI recovered after the retry.",
        label: "Recheck CI",
        namespace: "junior",
        resourceType: "timer",
      },
      {
        childAgent: {
          conversationId: "junior:internal:dashboard-qa:advisor-review",
          name: "reviewer",
        },
        createdAt: iso(-20 * 60_000),
        events: ["pull_request.review_comment.created"],
        expiresAt: iso(6 * DAY_MS),
        id: "watch-child",
        intent: "Reply to new review comments on the PR.",
        label: "getsentry/junior#2351",
        namespace: "github",
        resourceType: "pull_request",
      },
      {
        createdAt: iso(-10 * 60_000),
        events: ["message.posted"],
        expiresAt: iso(3 * DAY_MS),
        id: "watch-redacted",
        namespace: "slack",
        redacted: true,
        resourceType: "channel",
      },
    ],
  };
}
