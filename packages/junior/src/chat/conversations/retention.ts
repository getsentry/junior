/**
 * Content retention policy and the bounded purge job.
 *
 * Retention follows conversation privacy: content is kept for a window measured
 * from `last_activity_at` and deleted wholesale by a dedicated cron. Visibility
 * is resolved at purge time through the parent chain to the root's destination,
 * so no expiry is ever stored and a public↔private flip takes effect on the next
 * pass. Storage write paths own no TTLs.
 */
import { logException, logInfo } from "@/chat/logging";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  purgeConversationTree,
  resolveRootVisibility,
  selectExpiredRoots,
} from "./sql/purge";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Content retention windows keyed by resolved conversation visibility. */
export const CONTENT_RETENTION_MS = {
  public: 90 * DAY_MS,
  private: 14 * DAY_MS,
} as const;

/** Maximum root conversation trees purged per bounded batch run. */
const RETENTION_BATCH_LIMIT = 200;

/** Aggregate outcome of one bounded retention purge batch. */
export interface RetentionPurgeResult {
  /** Root conversations examined and attempted this run. */
  scanned: number;
  /** Root trees successfully purged. */
  purged: number;
  /** Root trees whose purge failed and were skipped. */
  failed: number;
  /** Total conversation rows (roots plus descendants) stamped by the purge. */
  conversations: number;
}

/**
 * Run one bounded retention purge batch: delete expired root conversation trees
 * oldest-activity-first. Each tree is purged transactionally in isolation, so a
 * single failing tree is logged and skipped without aborting the batch, and the
 * remainder of an over-limit backlog is left for the next run.
 */
export async function runRetentionPurge(
  executor: JuniorSqlDatabase,
  args: { nowMs: number; limit?: number },
): Promise<RetentionPurgeResult> {
  const limit = args.limit ?? RETENTION_BATCH_LIMIT;
  const startedAtMs = Date.now();
  const roots = await selectExpiredRoots(executor, {
    nowMs: args.nowMs,
    publicWindowMs: CONTENT_RETENTION_MS.public,
    privateWindowMs: CONTENT_RETENTION_MS.private,
    limit,
  });
  let purged = 0;
  let failed = 0;
  let conversations = 0;
  for (const root of roots) {
    try {
      const result = await purgeConversationTree(executor, {
        rootConversationId: root.conversationId,
        nowMs: args.nowMs,
        retention: {
          publicWindowMs: CONTENT_RETENTION_MS.public,
          privateWindowMs: CONTENT_RETENTION_MS.private,
        },
      });
      if (result.purged) {
        purged += 1;
        conversations += result.conversations;
      }
    } catch (error) {
      failed += 1;
      logException(
        error,
        "retention_purge_tree_failed",
        { conversationId: root.conversationId },
        {},
        "Retention purge failed for one conversation tree",
      );
    }
  }
  logInfo(
    "retention_purge_completed",
    {},
    {
      "app.retention.scanned": roots.length,
      "app.retention.purged": purged,
      "app.retention.failed": failed,
      "app.retention.conversations": conversations,
      "app.retention.duration_ms": Date.now() - startedAtMs,
    },
    "Retention purge batch completed",
  );
  return { scanned: roots.length, purged, failed, conversations };
}

/**
 * Erase one conversation's content and descendants immediately, regardless of
 * age, applying the same visibility-based metadata scrubbing as the purge job.
 * The scrub decision uses the root's resolved visibility so erasing a child
 * still fails closed to private for a private root.
 */
export async function purgeConversation(
  executor: JuniorSqlDatabase,
  conversationId: string,
  opts: { nowMs?: number } = {},
): Promise<void> {
  const { visibility } = await resolveRootVisibility(executor, conversationId);
  await purgeConversationTree(executor, {
    rootConversationId: conversationId,
    scrubMetadata: visibility !== "public",
    nowMs: opts.nowMs ?? Date.now(),
  });
}
