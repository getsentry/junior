import {
  and,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorCodeChanges,
  juniorConversationBriefs,
  juniorConversations,
} from "@/db/schema";
import { conversationUsageCostExpr } from "./aggregate";

export interface OutcomeBucket {
  date: string;
  mergedCodeChangeCostUsd: number;
  mergedCodeChanges: number;
  outcomeCostUsd: number;
  outcomes: number;
}

const changes = juniorCodeChanges;
const linked = alias(juniorConversations, "linked");
// A code change lists every Conversation that worked on it.
const linksChange = sql`${linked.conversationId} = any(${changes.conversationIds})`;
// Roots normally reference themselves. A root without the reference is its
// own root.
const linkedRoot = sql<string>`coalesce(${linked.rootConversationId}, ${linked.conversationId})`;

/**
 * Count outcomes per UTC day or hour, with the conversation cost that
 * produced them. An outcome is one of:
 *
 * - a merged code change, at its merge time. Each root Conversation splits its
 *   tree cost evenly across all of its merged code changes, so a long
 *   Conversation that merges three changes makes each one cheaper.
 * - a root Conversation with no linked code change whose latest Brief is
 *   `done` or `answered`, at its last activity. Its whole tree cost counts.
 *
 * Roots with only open or closed code changes count nothing until a change
 * merges, so one Conversation is never both kinds of outcome. A merged change
 * with no linked Conversation has an unknown cost, not a zero cost, so it is
 * left out instead of making the mean look cheaper.
 */
export async function readOutcomeBuckets(
  db: JuniorDatabase,
  options: { bucket: "day" | "hour"; start: Date; end: Date },
): Promise<OutcomeBucket[]> {
  const [merges, briefRoots] = await Promise.all([
    readWindowMerges(db, options),
    readBriefOutcomeRoots(db, options),
  ]);
  const mergeRoots = [...new Set(merges.map((merge) => merge.rootId))];
  const [rootMerges, treeCosts] = await Promise.all([
    readRootMergeCounts(db, mergeRoots),
    readTreeCosts(db, [
      ...mergeRoots,
      ...briefRoots.map((root) => root.rootId),
    ]),
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
        outcomeCostUsd: 0,
        outcomes: 0,
      };
      buckets.set(date, bucket);
    }
    return bucket;
  };

  // A change linked to several roots is one outcome that takes a share of
  // each root's cost.
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
    bucket.outcomes += 1;
    bucket.outcomeCostUsd += change.costUsd;
  }
  for (const root of briefRoots) {
    const bucket = bucketAt(root.lastActivityAt);
    bucket.outcomes += 1;
    bucket.outcomeCostUsd += treeCosts.get(root.rootId) ?? 0;
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

async function readBriefOutcomeRoots(
  db: JuniorDatabase,
  options: { start: Date; end: Date },
) {
  const roots = juniorConversations;
  const briefs = juniorConversationBriefs;
  const latestBrief = db
    .select({
      status: sql<string | null>`${briefs.content}->'outcome'->>'status'`.as(
        "status",
      ),
    })
    .from(briefs)
    .where(eq(briefs.conversationId, roots.conversationId))
    .orderBy(desc(briefs.version))
    .limit(1)
    .as("latest_brief");
  return await db
    .select({
      lastActivityAt: roots.lastActivityAt,
      rootId: roots.conversationId,
    })
    .from(roots)
    .innerJoinLateral(latestBrief, sql`true`)
    .where(
      and(
        isNull(roots.parentConversationId),
        gte(roots.lastActivityAt, options.start),
        lte(roots.lastActivityAt, options.end),
        inArray(latestBrief.status, ["done", "answered"]),
        notExists(
          db
            .select({ id: changes.id })
            .from(changes)
            .innerJoin(linked, linksChange)
            .where(eq(linkedRoot, roots.conversationId)),
        ),
      ),
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
