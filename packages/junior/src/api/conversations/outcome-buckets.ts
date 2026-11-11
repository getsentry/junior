import { sql } from "drizzle-orm";
import * as z from "zod";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";
import { conversationUsageCostExpr } from "./aggregate";

const outcomeBucketSchema = z
  .object({
    date: z.string(),
    mergedCodeChangeCostUsd: z.number(),
    mergedCodeChanges: z.number().int().nonnegative(),
    outcomeCostUsd: z.number(),
    outcomes: z.number().int().nonnegative(),
  })
  .strict();

export type OutcomeBucket = z.infer<typeof outcomeBucketSchema>;

const resultSchema = z.object({ rows: z.array(outcomeBucketSchema) });

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
 * merges, so one Conversation is never both kinds of outcome.
 */
export async function readOutcomeBuckets(
  db: JuniorDatabase,
  options: { bucket: "day" | "hour"; start: Date; end: Date },
): Promise<OutcomeBucket[]> {
  const format =
    options.bucket === "day" ? sql`'YYYY-MM-DD'` : sql`'YYYY-MM-DD"T"HH24'`;
  const { start, end } = options;
  const cost = conversationUsageCostExpr(juniorConversations.usage);
  const result = await db.execute(sql`
    WITH code_links AS (
      SELECT DISTINCT
        changes.id AS change_id,
        changes.state,
        changes.merged_at,
        coalesce(linked.root_conversation_id, linked.conversation_id) AS root_id
      FROM junior_code_changes AS changes
      CROSS JOIN LATERAL unnest(changes.conversation_ids) AS ids(conversation_id)
      INNER JOIN junior_conversations AS linked
        ON linked.conversation_id = ids.conversation_id
    ), root_merges AS (
      SELECT root_id, count(*)::double precision AS merged
      FROM code_links
      WHERE state = 'merged'
      GROUP BY root_id
    ), window_merges AS (
      SELECT change_id, merged_at, root_id
      FROM code_links
      WHERE state = 'merged'
        AND merged_at >= ${start}
        AND merged_at <= ${end}
    ), brief_roots AS (
      SELECT roots.conversation_id AS root_id, roots.last_activity_at
      FROM junior_conversations AS roots
      CROSS JOIN LATERAL (
        SELECT briefs.content
        FROM junior_conversation_briefs AS briefs
        WHERE briefs.conversation_id = roots.conversation_id
        ORDER BY briefs.version DESC
        LIMIT 1
      ) AS latest
      WHERE roots.parent_conversation_id IS NULL
        AND roots.last_activity_at >= ${start}
        AND roots.last_activity_at <= ${end}
        AND latest.content->'outcome'->>'status' IN ('done', 'answered')
        AND NOT EXISTS (
          SELECT 1 FROM code_links WHERE code_links.root_id = roots.conversation_id
        )
    ), tree_costs AS (
      -- Roots reference themselves, so the root index finds each tree.
      SELECT
        ${juniorConversations.rootConversationId} AS root_id,
        coalesce(sum(${cost}), 0)::double precision AS cost_usd
      FROM ${juniorConversations}
      WHERE ${juniorConversations.rootConversationId} IN (
        SELECT root_id FROM window_merges
        UNION
        SELECT root_id FROM brief_roots
      )
      GROUP BY 1
    ), outcomes AS (
      SELECT
        to_char(window_merges.merged_at AT TIME ZONE 'UTC', ${format}) AS date,
        true AS merged,
        sum(coalesce(tree_costs.cost_usd, 0) / root_merges.merged) AS cost_usd
      FROM window_merges
      INNER JOIN root_merges USING (root_id)
      LEFT JOIN tree_costs USING (root_id)
      GROUP BY window_merges.change_id, 1
      UNION ALL
      SELECT
        to_char(brief_roots.last_activity_at AT TIME ZONE 'UTC', ${format}),
        false,
        coalesce(tree_costs.cost_usd, 0)
      FROM brief_roots
      LEFT JOIN tree_costs USING (root_id)
    )
    SELECT
      date,
      count(*) FILTER (WHERE merged)::integer AS "mergedCodeChanges",
      coalesce(sum(cost_usd) FILTER (WHERE merged), 0)::double precision
        AS "mergedCodeChangeCostUsd",
      count(*)::integer AS "outcomes",
      coalesce(sum(cost_usd), 0)::double precision AS "outcomeCostUsd"
    FROM outcomes
    GROUP BY date
  `);
  return resultSchema.parse(result).rows;
}
