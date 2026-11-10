import type { ConversationDetailReport } from "@sentry/junior/api/schema";

type Brief = NonNullable<ConversationDetailReport["brief"]>;
type Status = Brief["content"]["outcome"]["status"];

type BriefSpec = {
  intent: string;
  outcome: string;
  status: Status;
  summary: string;
  /** Minutes since the Brief last changed. */
  updatedMinutesAgo: number;
  version: number;
};

/**
 * Briefs for mock Conversations that have none, keyed by title. They cover
 * every outcome status, so list rows, headers, and inbox bundles show each
 * one. The prototype's navigation reads them.
 */
const BRIEFS: Record<string, BriefSpec> = {
  "Closed issue summary": {
    intent: "Summarize ACME-42 for the release notes after it closes.",
    outcome: "The summary is posted to #project-updates.",
    status: "done",
    summary:
      "ACME-42 closed after the retry fix shipped. Junior posted a three-line summary with the root cause and the fix.",
    updatedMinutesAgo: 120,
    version: 1,
  },
  "Daily operations digest": {
    intent: "Post the daily operations digest for the on-call team.",
    outcome: "The digest is posted. Two noisy alerts were left out.",
    status: "partial",
    summary:
      "Today's digest covers three incidents and the deploy queue. Two noisy alerts were skipped and need a threshold change.",
    updatedMinutesAgo: 240,
    version: 5,
  },
  "Dashboard QA edge cases": {
    intent:
      "Check the empty, loading, and failed transcript states and the pinned-row order.",
    outcome: "Two states pass. The pinned-row order still needs a review.",
    status: "in_progress",
    summary:
      "Junior is checking the dashboard's transcript states and pinned-row order. The empty state reuses the loading skeleton; review on #3052 is open.",
    updatedMinutesAgo: 230,
    version: 4,
  },
  "Deployment investigation failed": {
    intent: "Find why the canary deploy paused and whether to roll back.",
    outcome: "Junior cannot read the GoCD job logs without access.",
    status: "blocked",
    summary:
      "The canary deploy paused on the error-budget alarm. Junior needs GoCD log access before it can say whether to roll back.",
    updatedMinutesAgo: 30,
    version: 2,
  },
  "Direct Message": {
    intent: "Answer which region the payments canary runs in.",
    outcome: "Answered: us-east-1.",
    status: "answered",
    summary: "A quick question about the payments canary region. Answered.",
    updatedMinutesAgo: 21,
    version: 1,
  },
  "Package release and self-update": {
    intent: "Release @sentry/junior 0.288.0 and update the app to it.",
    outcome:
      "The package is published. The self-update PR waits to merge, and payments#91 waits on a review.",
    status: "partial",
    summary:
      "@sentry/junior 0.288.0 is published and the self-update PR is approved. The deploy waits on the merge and on the payments review.",
    updatedMinutesAgo: 12,
    version: 3,
  },
  "Plan the billing migration": {
    intent: "Plan next week's billing migration window and table order.",
    outcome: "Three questions about the window and negative invoices wait.",
    status: "blocked",
    summary:
      "Junior drafted the billing migration plan. It cannot pick the window or the negative-invoice handling until you answer.",
    updatedMinutesAgo: 40,
    version: 2,
  },
  "Quarterly reliability review": {
    intent: "Prepare the quarterly reliability review from the incident log.",
    outcome: "The review doc is answered and shared with the team.",
    status: "answered",
    summary:
      "Junior compiled 24 incidents into the quarterly review. Error budgets held for checkout and payments; ingestion missed twice.",
    updatedMinutesAgo: 4 * 24 * 60,
    version: 6,
  },
  "Roll out payments-v42": {
    intent: "Ship payments-v42 once the canary is clean.",
    outcome: "The canary is clean. The full rollout waits on your approval.",
    status: "in_progress",
    summary:
      "The payments-v42 canary ran 30 minutes in us-east-1 with flat errors and p95. Junior waits for your go-ahead to roll out everywhere.",
    updatedMinutesAgo: 26,
    version: 3,
  },
  "Sandbox validation": {
    intent: "Check that sandbox snapshots rebuild after the image bump.",
    outcome: "Snapshots rebuilt and the smoke test passed.",
    status: "done",
    summary:
      "The sandbox image bump rebuilt every snapshot. The smoke test passed on all three workspaces.",
    updatedMinutesAgo: 240,
    version: 2,
  },
  "Release train": {
    intent: "Cut a release when main has changes since the last tag.",
    outcome: "The release train is paused, so nothing shipped.",
    status: "abandoned",
    summary: "The weekly release train is paused. No release was cut.",
    updatedMinutesAgo: 3 * 24 * 60,
    version: 1,
  },
};

/** Add a mock Brief to a Conversation that has none. */
export function withMockBrief<
  T extends Pick<
    ConversationDetailReport,
    "brief" | "displayTitle" | "startedAt"
  >,
>(conversation: T, nowMs: number): T {
  if (conversation.brief) return conversation;
  const spec = BRIEFS[conversation.displayTitle];
  if (!spec) return conversation;
  const updatedAt = new Date(
    nowMs - spec.updatedMinutesAgo * 60_000,
  ).toISOString();
  const startedAt =
    Date.parse(conversation.startedAt) < Date.parse(updatedAt)
      ? conversation.startedAt
      : updatedAt;
  return {
    ...conversation,
    brief: {
      content: {
        decisions: [],
        facts: [],
        intent: spec.intent,
        keywords: [],
        links: [],
        outcome: { status: spec.status, text: spec.outcome },
        record: {
          assistantMessages: 2,
          codeChanges: [],
          durationMs: Math.max(
            0,
            Date.parse(updatedAt) - Date.parse(startedAt),
          ),
          events: 0,
          lastActivityAt: updatedAt,
          participants: [{ messages: 2, name: "Morgan Lee" }],
          startedAt,
          toolResults: 1,
          userMessages: 2,
        },
        schemaVersion: 1,
        summary: spec.summary,
      },
      updatedAt,
      version: spec.version,
    },
  };
}
