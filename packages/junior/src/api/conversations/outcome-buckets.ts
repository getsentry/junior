import {
  and,
  countDistinct,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
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
// A code change lists every Conversation that worked on it.
const linksChange = sql`${linked.conversationId} = any(${changes.conversationIds})`;
// Roots normally reference themselves. A root without the reference is its
// own root.
const linkedRoot = sql<string>`coalesce(${linked.rootConversationId}, ${linked.conversationId})`;

/**
 * Count merged code changes per UTC day or hour, at their merge time, with
 * the conversation cost that produced them. Each root Conversation splits its
 * tree cost evenly across all of its merged code changes, so a long
 * Conversation that merges three changes makes each one cheaper. A merged
 * change with no linked Conversation has an unknown cost, not a zero cost, so
 * it is left out instead of making the mean look cheaper.
 */
export async function readOutcomeBuckets(
  db: JuniorDatabase,
  options: { bucket: "day" | "hour"; start: Date; end: Date },
): Promise<OutcomeBucket[]> {
  const merges = await readWindowMerges(db, options);
  const mergeRoots = [...new Set(merges.map((merge) => merge.rootId))];
  const [rootMerges, treeCosts] = await Promise.all([
    readRootMergeCounts(db, mergeRoots),
    readTreeCosts(db, mergeRoots),
  ]);

  const dateLength = options.bucket === "day" ? 10 : 13;
  const buckets = new Map<string, OutcomeBucket>();
  const bucketAt = (instant: Date) => {
    const date = instant.toISOString().slice(0, dateLength);
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
  for (const merge of merges) {
    const share =
      (treeCosts.get(merge.rootId) ?? 0) / (rootMerges.get(merge.rootId) ?? 1);
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

async function readWindowMerges(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
) {
  const rows = await db
    .selectDistinct({
      changeId: changes.id,
      mergedAt: changes.mergedAt,
      rootId: linkedRoot,
    })
    .from(changes)
    .innerJoin(linked, linksChange)
    .where(
      and(
        eq(changes.state, "merged"),
        gte(changes.mergedAt, options.start),
        lte(changes.mergedAt, options.end),
      ),
    );
  return rows.flatMap(({ changeId, mergedAt, rootId }) =>
    mergedAt && rootId ? [{ changeId, mergedAt, rootId }] : [],
  );
}

/** Merged code changes of all time per root, so each merge gets its share. */
async function readRootMergeCounts(
  db: JuniorDatabase,
  rootIds: readonly string[],
): Promise<Map<string, number>> {
  if (!rootIds.length) return new Map();
  const rows = await db
    .select({
      merged: countDistinct(changes.id),
      rootId: linkedRoot,
    })
    .from(changes)
    .innerJoin(linked, linksChange)
    .where(and(eq(changes.state, "merged"), inArray(linkedRoot, [...rootIds])))
    .groupBy(linkedRoot);
  return new Map(
    rows.flatMap((row) => (row.rootId ? [[row.rootId, row.merged]] : [])),
  );
}

async function readTreeCosts(
  db: JuniorDatabase,
  rootIds: readonly string[],
): Promise<Map<string, number>> {
  if (!rootIds.length) return new Map();
  const conversations = juniorConversations;
  const ids = [...new Set(rootIds)];
  const treeRoot = sql<string>`coalesce(${conversations.rootConversationId}, ${conversations.conversationId})`;
  const rows = await db
    .select({
      costUsd: sql<number>`coalesce(sum(${conversationUsageCostExpr(conversations.usage)}), 0)::double precision`,
      rootId: treeRoot,
    })
    .from(conversations)
    // The root index finds each tree. The id match adds a root without the
    // reference.
    .where(
      or(
        inArray(conversations.rootConversationId, ids),
        inArray(conversations.conversationId, ids),
      ),
    )
    .groupBy(treeRoot);
  return new Map(
    rows.flatMap((row) => (row.rootId ? [[row.rootId, row.costUsd]] : [])),
  );
}
