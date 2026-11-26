import {
  and,
  eq,
  gte,
  isNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import { juniorCodeChanges, juniorConversations } from "@/db/schema";
import { conversationUsageCostExpr } from "./aggregate";

export interface OutcomeBucket {
  date: string;
  mergedCodeChangeCostUsd: number;
  mergedCodeChanges: number;
}

const changes = juniorCodeChanges;
const linked = alias(juniorConversations, "linked");
const tree = alias(juniorConversations, "outcome_tree");
// A code change lists every Conversation that worked on it. Joining the
// unnested ids by equality lets Postgres hash-join them to Conversations
// instead of looking up each listed id by key.
const unnestedConversationId = sql<string>`unnest(${changes.conversationIds})`;
// Roots normally reference themselves. A root without the reference is its
// own root.
const linkedRoot = sql<string>`coalesce(${linked.rootConversationId}, ${linked.conversationId})`;

/** A root Conversation active in the window, with its whole tree. */
export interface WindowRoot {
  lastActivityAt: Date;
  rootId: string;
  /** Conversations that reference the root. A root references itself. */
  treeConversations: number;
  treeCostUsd: number;
}

/**
 * Count merged code changes per UTC hour, at their merge time, with the
 * conversation cost that produced them. Each root Conversation splits its
 * tree cost evenly across all of its merged code changes, so a long
 * Conversation that merges three changes makes each one cheaper. A merged
 * change with no linked Conversation has an unknown cost, not a zero cost, so
 * it is left out instead of making the mean look cheaper.
 */
export function outcomeBuckets(reads: {
  merges: ReadonlyArray<WindowMerge>;
}): OutcomeBucket[] {
  const buckets = new Map<string, OutcomeBucket>();
  const bucketAt = (instant: Date) => {
    const date = instant.toISOString().slice(0, 13);
    let bucket = buckets.get(date);
    if (!bucket) {
      bucket = {
        date,
        mergedCodeChangeCostUsd: 0,
        mergedCodeChanges: 0,
      };
      buckets.set(date, bucket);
    }
    return bucket;
  };

  // A change linked to several roots takes a share of each root's cost.
  const changeCosts = new Map<string, { costUsd: number; mergedAt: Date }>();
  for (const merge of reads.merges) {
    const share = merge.treeCostUsd / merge.rootMerges;
    const change = changeCosts.get(merge.changeId);
    if (change) change.costUsd += share;
    else
      changeCosts.set(merge.changeId, {
        costUsd: share,
        mergedAt: merge.mergedAt,
      });
  }
  for (const change of changeCosts.values()) {
    const bucket = bucketAt(change.mergedAt);
    bucket.mergedCodeChanges += 1;
    bucket.mergedCodeChangeCostUsd += change.costUsd;
  }
  return [...buckets.values()];
}

/**
 * Read each root Conversation active in the window, with the size and cost
 * of its tree. One join reads every tree, so a stats read does not look up
 * each tree on its own.
 */
export async function readWindowRoots(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
): Promise<WindowRoot[]> {
  const roots = juniorConversations;
  // A root without the reference is still part of its own tree.
  const unreferencedRootCost = sql`CASE
    WHEN ${roots.rootConversationId} IS DISTINCT FROM ${roots.conversationId}
      THEN COALESCE(${conversationUsageCostExpr(roots.usage)}, 0)
    ELSE 0
  END`;
  return await db
    .select({
      lastActivityAt: roots.lastActivityAt,
      rootId: roots.conversationId,
      treeConversations: sql<number>`count(${tree.conversationId})::integer`,
      treeCostUsd: sql<number>`(
        coalesce(sum(${conversationUsageCostExpr(tree.usage)}), 0)
          + ${unreferencedRootCost}
      )::double precision`,
    })
    .from(roots)
    .leftJoin(tree, eq(tree.rootConversationId, roots.conversationId))
    .where(
      and(
        isNull(roots.parentConversationId),
        gte(roots.lastActivityAt, options.start),
        lte(roots.lastActivityAt, options.end),
      ),
    )
    .groupBy(roots.conversationId);
}

/** The summed usage cost of the Conversation tree of `rootId`. */
function treeCostUsd(db: JuniorDatabase, rootId: SQLWrapper) {
  // The root index finds each tree. The id match adds a root without the
  // reference.
  const cost = db
    .select({
      costUsd: sql`coalesce(sum(${conversationUsageCostExpr(tree.usage)}), 0)`,
    })
    .from(tree)
    .where(
      or(eq(tree.rootConversationId, rootId), eq(tree.conversationId, rootId)),
    );
  return sql<number>`(${cost})::double precision`;
}

type WindowMerge = Awaited<ReturnType<typeof readWindowMerges>>[number];

/**
 * Merged code changes in the window, one row per linked root, with the
 * merged changes of all time of that root, so each merge gets its share.
 */
export async function readWindowMerges(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
) {
  const mergedIds = db
    .select({
      changeId: changes.id,
      listedId: unnestedConversationId.as("listed_id"),
      mergedAt: changes.mergedAt,
    })
    .from(changes)
    .where(eq(changes.state, "merged"))
    .as("merged_ids");
  const mergedRoots = db
    .selectDistinct({
      changeId: mergedIds.changeId,
      mergedAt: mergedIds.mergedAt,
      rootId: linkedRoot.as("root_id"),
    })
    .from(mergedIds)
    .innerJoin(linked, eq(linked.conversationId, mergedIds.listedId))
    .as("merged_roots");
  const counted = db
    .select({
      changeId: mergedRoots.changeId,
      mergedAt: mergedRoots.mergedAt,
      rootId: mergedRoots.rootId,
      rootMerges:
        sql<number>`count(*) over (partition by ${mergedRoots.rootId})::integer`.as(
          "root_merges",
        ),
    })
    .from(mergedRoots)
    .as("counted_merges");
  const rows = await db
    .select({
      changeId: counted.changeId,
      mergedAt: counted.mergedAt,
      rootId: counted.rootId,
      rootMerges: counted.rootMerges,
      treeCostUsd: treeCostUsd(db, counted.rootId),
    })
    .from(counted)
    .where(
      and(
        gte(counted.mergedAt, options.start),
        lte(counted.mergedAt, options.end),
      ),
    );
  return rows.flatMap(({ mergedAt, rootId, ...merge }) =>
    mergedAt && rootId ? [{ ...merge, mergedAt, rootId }] : [],
  );
}
