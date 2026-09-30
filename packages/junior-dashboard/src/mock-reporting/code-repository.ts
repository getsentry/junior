import type {
  CodeRepositoryReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";

import { readMockCodeOverview } from "./fixtures";

const MOCK_WORKSPACES: Record<string, CodeRepositoryReport["workspaces"]> = {
  "getsentry/junior": [{ id: "workspace-junior", name: "junior" }],
};

/** Build one mock repository report from the mock Code overview. */
export function readMockCodeRepository(
  repositoryId: string,
): CodeRepositoryReport | undefined {
  const overview = readMockCodeOverview();
  const repository = overview.repositories.find(
    (entry) => entry.id === repositoryId,
  );
  if (!repository) return undefined;
  return {
    activityDays: overview.activityDays,
    changes: overview.changes.filter(
      (change) => change.repository === repository.name,
    ),
    generatedAt: overview.generatedAt,
    repository: {
      id: repository.id,
      name: repository.name,
      provider: repository.provider,
      ...(repository.url ? { url: repository.url } : undefined),
    },
    summary: {
      closed: repository.closed,
      created: repository.created,
      merged: repository.merged,
      open: repository.open,
      ...(repository.mergeRate === undefined
        ? undefined
        : { mergeRate: repository.mergeRate }),
      ...(repository.medianCostUsd === undefined
        ? undefined
        : {
            // Mock rows have no total cost; estimate it from the median.
            costUsd: repository.medianCostUsd * repository.created,
            medianCostUsd: repository.medianCostUsd,
          }),
      ...(overview.summary.medianMergeTimeMs === undefined
        ? undefined
        : { medianMergeTimeMs: overview.summary.medianMergeTimeMs }),
    },
    windowEnd: overview.windowEnd,
    windowStart: overview.windowStart,
    workspaces: MOCK_WORKSPACES[repository.name] ?? [],
  };
}

/**
 * Keep mock conversations whose code change annotations name the repository.
 * The real API links conversations through recorded code changes.
 */
export function filterMockConversationsByRepository(
  feed: ConversationFeed,
  repositoryId: string,
): ConversationFeed {
  const name = readMockCodeRepository(repositoryId)?.repository.name;
  return {
    ...feed,
    conversations: name
      ? feed.conversations.filter((conversation) =>
          conversation.sidebarAnnotations?.some((annotation) =>
            annotation.key.startsWith(`${name}#`),
          ),
        )
      : [],
  };
}
