import type { ConversationWatchesReport } from "@sentry/junior/api/schema";
import {
  ACTIVE_CONVERSATION_ID,
  DASHBOARD_QA_CONVERSATION_ID,
  DASHBOARD_QA_NESTED_THREAD_ID,
  DASHBOARD_QA_THREAD_ID,
  NOW_MS,
  readMockConversationDetail,
} from "./fixtures";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

// Watch times are relative to the fixed fixture time, like the rest of the
// mock data. The dashboard e2e browser clock is fixed there too, so "fires in"
// labels and screenshots stay the same on every run.
function iso(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

/** Process-local cancels, so mock QA can cancel a Watch. */
const cancelledMockWatchIds = new Set<string>();

/** Clear mock Watch cancels so tests sharing a worker do not leak state. */
export function resetMockWatches(): void {
  cancelledMockWatchIds.clear();
}

/**
 * Return the active Watches of one mock Conversation. The dashboard QA
 * Conversation has one Watch of each common shape: a pull request that is
 * also linked work, a deployment with a match filter, a timer, a redacted
 * Watch, and one that a child agent created. The viewer takes part in the
 * active Conversation, so its timer and event Watch show Cancel.
 */
export function readMockConversationWatches(
  conversationId: string,
): ConversationWatchesReport | undefined {
  if (!readMockConversationDetail(conversationId)) return undefined;
  const watches = MOCK_WATCHES[conversationId]?.() ?? [];
  return {
    conversationId,
    watches: watches.filter((watch) => !cancelledMockWatchIds.has(watch.id)),
  };
}

/**
 * Cancel one active mock Watch through the Conversation that created it: a
 * parent's own Watch, or a child's Watch through the child, like the API.
 * Returns false when that Conversation does not have it, or when the viewer
 * does not take part, as the API refuses then.
 */
export function cancelMockConversationWatch(
  conversationId: string,
  watchId: string,
): boolean {
  if (!readMockConversationDetail(conversationId)?.isParticipant) return false;
  const watch = Object.entries(MOCK_WATCHES)
    .flatMap(([ownerId, watches]) =>
      watches().map((candidate) => ({ candidate, ownerId })),
    )
    .find(
      ({ candidate, ownerId }) =>
        candidate.id === watchId &&
        !cancelledMockWatchIds.has(watchId) &&
        (candidate.childAgent
          ? candidate.childAgent.conversationId === conversationId
          : ownerId === conversationId),
    );
  if (!watch) return false;
  cancelledMockWatchIds.add(watchId);
  return true;
}

const MOCK_WATCHES: Record<string, () => ConversationWatchesReport["watches"]> =
  {
    [ACTIVE_CONVERSATION_ID]: () => [
      {
        createdAt: iso(-5 * 60_000),
        events: ["timer.fired"],
        expiresAt: iso(DAY_MS + 25 * 60_000),
        firesAt: iso(25 * 60_000),
        id: "watch-active-timer",
        intent: "Remind Morgan to confirm the rollback window.",
        label: "Timer",
        namespace: "junior",
        resourceType: "timer",
      },
      {
        createdAt: iso(-20 * 60_000),
        events: ["metric_alert.resolved"],
        expiresAt: iso(3 * DAY_MS),
        id: "watch-active-alert",
        intent: "Post when the checkout p95 alert resolves.",
        label: "Checkout p95 latency",
        namespace: "sentry",
        resourceType: "metric_alert",
      },
    ],
    [DASHBOARD_QA_CONVERSATION_ID]: () => [
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
        label: "getsentry/getsentry#21572",
        namespace: "github",
        resourceType: "pull_request",
        url: "https://github.com/getsentry/getsentry/pull/21572",
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
        url: "https://github.com/getsentry/junior/pull/2351",
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
    // The viewer takes part in this Thread, so its child's Watch shows
    // Cancel in the child's row menu.
    [DASHBOARD_QA_THREAD_ID]: () => [
      {
        childAgent: {
          conversationId: DASHBOARD_QA_NESTED_THREAD_ID,
          name: "Recheck pin order in Safari",
        },
        createdAt: iso(-40 * 60_000),
        events: ["deployment.succeeded"],
        expiresAt: iso(DAY_MS),
        id: "watch-thread-child",
        intent: "Recheck in Safari when the preview deploy is ready.",
        label: "junior-dashboard preview",
        namespace: "vercel",
        resourceType: "deployment",
      },
    ],
  };
