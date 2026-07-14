/**
 * Repair legacy usage from durable SQL steps in bounded, retry-safe batches.
 * Ephemeral run summaries are not an authority because TTL can erase evidence.
 */
import { getChatConfig } from "@/chat/config";
import { createJuniorSqlExecutor } from "@/db/executor";
import type { JuniorSqlExecutor } from "@/db/db";
import type { MigrationContext, MigrationResult } from "../types";

const CONVERSATION_USAGE_REPAIR_BATCH_SIZE = 500;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_FINITE_DOUBLE = "1.7976931348623157e308";
const REPAIR_LOCK = "junior:upgrade:repair-conversation-usage";

interface UsageRepairSource {
  changed: boolean;
  conversationId: string;
  matched: boolean;
  repairable: boolean;
}

const USAGE_REPAIR_BATCH_SQL = `
WITH candidates AS MATERIALIZED (
  SELECT
    conversation_id,
    updated_at,
    execution_updated_at
  FROM junior_conversations
  WHERE parent_conversation_id IS NULL
    AND execution_status = 'idle'
    AND conversation_id > $1
  ORDER BY conversation_id
  LIMIT $2
),
-- Occurrence numbers preserve intentional duplicates within one epoch while
-- collapsing context copies of the same message across rebuilt epochs.
message_occurrences AS (
  SELECT
    step.conversation_id,
    step.payload -> 'message' AS message,
    row_number() OVER (
      PARTITION BY
        step.conversation_id,
        step.context_epoch,
        step.payload -> 'message'
      ORDER BY step.seq
    ) AS occurrence
  FROM junior_agent_steps AS step
  INNER JOIN candidates AS candidate
    ON candidate.conversation_id = step.conversation_id
  WHERE step.type = 'pi_message'
    AND step.role = 'assistant'
    AND jsonb_typeof(step.payload -> 'message' -> 'usage') = 'object'
),
canonical_messages AS (
  SELECT DISTINCT conversation_id, message, occurrence
  FROM message_occurrences
),
usage_values AS (
  SELECT
    conversation_id,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'input') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'input')::numeric))
      WHEN jsonb_typeof(message -> 'usage' -> 'inputTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'inputTokens')::numeric))
    END AS input_tokens,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'output') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'output')::numeric))
      WHEN jsonb_typeof(message -> 'usage' -> 'outputTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'outputTokens')::numeric))
    END AS output_tokens,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'cacheRead') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'cacheRead')::numeric))
      WHEN jsonb_typeof(message -> 'usage' -> 'cachedInputTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'cachedInputTokens')::numeric))
    END AS cached_input_tokens,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'cacheWrite') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'cacheWrite')::numeric))
      WHEN jsonb_typeof(message -> 'usage' -> 'cacheCreationTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'cacheCreationTokens')::numeric))
    END AS cache_creation_tokens,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'reasoning') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'reasoning')::numeric))
      WHEN jsonb_typeof(message -> 'usage' -> 'reasoningTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'reasoningTokens')::numeric))
    END AS reasoning_tokens,
    CASE
      WHEN jsonb_typeof(message -> 'usage' -> 'totalTokens') = 'number'
        THEN greatest(0, floor((message -> 'usage' ->> 'totalTokens')::numeric))
    END AS total_tokens,
    CASE WHEN jsonb_typeof(message -> 'usage' -> 'cost' -> 'input') = 'number'
      THEN greatest(0, (message -> 'usage' -> 'cost' ->> 'input')::numeric)
    END AS cost_input,
    CASE WHEN jsonb_typeof(message -> 'usage' -> 'cost' -> 'output') = 'number'
      THEN greatest(0, (message -> 'usage' -> 'cost' ->> 'output')::numeric)
    END AS cost_output,
    CASE WHEN jsonb_typeof(message -> 'usage' -> 'cost' -> 'cacheRead') = 'number'
      THEN greatest(0, (message -> 'usage' -> 'cost' ->> 'cacheRead')::numeric)
    END AS cost_cache_read,
    CASE WHEN jsonb_typeof(message -> 'usage' -> 'cost' -> 'cacheWrite') = 'number'
      THEN greatest(0, (message -> 'usage' -> 'cost' ->> 'cacheWrite')::numeric)
    END AS cost_cache_write,
    CASE WHEN jsonb_typeof(message -> 'usage' -> 'cost' -> 'total') = 'number'
      THEN greatest(0, (message -> 'usage' -> 'cost' ->> 'total')::numeric)
    END AS cost_total
  FROM canonical_messages
),
rollups AS (
  SELECT
    conversation_id,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(cached_input_tokens) AS cached_input_tokens,
    sum(cache_creation_tokens) AS cache_creation_tokens,
    sum(reasoning_tokens) AS reasoning_tokens,
    sum(
      CASE
        WHEN input_tokens IS NULL
          AND output_tokens IS NULL
          AND cached_input_tokens IS NULL
          AND cache_creation_tokens IS NULL
        THEN total_tokens
      END
    ) AS total_only_tokens,
    round(sum(cost_input), 12) AS cost_input,
    round(sum(cost_output), 12) AS cost_output,
    round(sum(cost_cache_read), 12) AS cost_cache_read,
    round(sum(cost_cache_write), 12) AS cost_cache_write,
    round(sum(cost_total), 12) AS cost_total
  FROM usage_values
  GROUP BY conversation_id
  HAVING count(input_tokens)
    + count(output_tokens)
    + count(cached_input_tokens)
    + count(cache_creation_tokens)
    + count(reasoning_tokens)
    + count(total_tokens)
    + count(cost_input)
    + count(cost_output)
    + count(cost_cache_read)
    + count(cost_cache_write)
    + count(cost_total) > 0
),
valid_rollups AS (
  SELECT *
  FROM rollups
  WHERE (input_tokens IS NULL OR input_tokens <= ${MAX_SAFE_INTEGER})
    AND (output_tokens IS NULL OR output_tokens <= ${MAX_SAFE_INTEGER})
    AND (cached_input_tokens IS NULL OR cached_input_tokens <= ${MAX_SAFE_INTEGER})
    AND (cache_creation_tokens IS NULL OR cache_creation_tokens <= ${MAX_SAFE_INTEGER})
    AND (reasoning_tokens IS NULL OR reasoning_tokens <= ${MAX_SAFE_INTEGER})
    AND (total_only_tokens IS NULL OR total_only_tokens <= ${MAX_SAFE_INTEGER})
    AND (
      total_only_tokens IS NULL
      OR total_only_tokens
        + coalesce(input_tokens, 0)
        + coalesce(output_tokens, 0)
        + coalesce(cached_input_tokens, 0)
        + coalesce(cache_creation_tokens, 0) <= ${MAX_SAFE_INTEGER}
    )
    AND (cost_input IS NULL OR cost_input <= ${MAX_FINITE_DOUBLE}::numeric)
    AND (cost_output IS NULL OR cost_output <= ${MAX_FINITE_DOUBLE}::numeric)
    AND (cost_cache_read IS NULL OR cost_cache_read <= ${MAX_FINITE_DOUBLE}::numeric)
    AND (cost_cache_write IS NULL OR cost_cache_write <= ${MAX_FINITE_DOUBLE}::numeric)
    AND (cost_total IS NULL OR cost_total <= ${MAX_FINITE_DOUBLE}::numeric)
),
normalized AS (
  SELECT
    conversation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'inputTokens', CASE WHEN total_only_tokens IS NULL THEN input_tokens END,
      'outputTokens', CASE WHEN total_only_tokens IS NULL THEN output_tokens END,
      'cachedInputTokens', CASE
        WHEN total_only_tokens IS NULL THEN cached_input_tokens
      END,
      'cacheCreationTokens', CASE
        WHEN total_only_tokens IS NULL THEN cache_creation_tokens
      END,
      'reasoningTokens', reasoning_tokens,
      'totalTokens', CASE
        WHEN total_only_tokens IS NOT NULL
        THEN total_only_tokens
          + coalesce(input_tokens, 0)
          + coalesce(output_tokens, 0)
          + coalesce(cached_input_tokens, 0)
          + coalesce(cache_creation_tokens, 0)
      END,
      'cost', CASE
        WHEN cost_input IS NULL
          AND cost_output IS NULL
          AND cost_cache_read IS NULL
          AND cost_cache_write IS NULL
          AND cost_total IS NULL
        THEN NULL
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'input', cost_input,
          'output', cost_output,
          'cacheRead', cost_cache_read,
          'cacheWrite', cost_cache_write,
          'total', cost_total
        ))
      END
    )) AS usage
  FROM valid_rollups
),
matched AS MATERIALIZED (
  SELECT conversation.conversation_id
  FROM junior_conversations AS conversation
  INNER JOIN candidates AS candidate USING (conversation_id)
  INNER JOIN normalized USING (conversation_id)
  WHERE conversation.execution_status = 'idle'
    AND conversation.updated_at = candidate.updated_at
    AND conversation.execution_updated_at IS NOT DISTINCT FROM candidate.execution_updated_at
  FOR UPDATE OF conversation
),
updated AS (
  UPDATE junior_conversations AS conversation
  SET usage_json = normalized.usage
  FROM normalized
  INNER JOIN matched USING (conversation_id)
  WHERE conversation.conversation_id = normalized.conversation_id
    AND conversation.usage_json IS DISTINCT FROM normalized.usage
  RETURNING conversation.conversation_id
)
SELECT
  candidate.conversation_id AS "conversationId",
  updated.conversation_id IS NOT NULL AS changed,
  matched.conversation_id IS NOT NULL AS matched,
  normalized.conversation_id IS NOT NULL AS repairable
FROM candidates AS candidate
LEFT JOIN normalized USING (conversation_id)
LEFT JOIN matched USING (conversation_id)
LEFT JOIN updated USING (conversation_id)
ORDER BY candidate.conversation_id
`;

/** Rebuild legacy conversation usage from canonical durable assistant messages. */
export async function repairConversationUsage(
  _context: MigrationContext,
  options: {
    batchSize?: number;
    executor?: JuniorSqlExecutor;
  } = {},
): Promise<MigrationResult> {
  let executor = options.executor;
  let closeExecutor: (() => Promise<void>) | undefined;
  if (!executor) {
    const { sql } = getChatConfig();
    executor = createJuniorSqlExecutor({
      connectionString: sql.databaseUrl,
      driver: sql.driver,
    });
    closeExecutor = () => executor!.close();
  }

  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? CONVERSATION_USAGE_REPAIR_BATCH_SIZE),
  );
  try {
    let cursor = "";
    let existing = 0;
    let migrated = 0;
    let missing = 0;
    let scanned = 0;
    let skipped = 0;

    while (true) {
      const sources = await executor.withLock(REPAIR_LOCK, () =>
        executor.query<UsageRepairSource>(USAGE_REPAIR_BATCH_SQL, [
          cursor,
          batchSize,
        ]),
      );
      if (sources.length === 0) break;

      scanned += sources.length;
      for (const source of sources) {
        if (!source.repairable) {
          missing += 1;
        } else if (source.changed) {
          migrated += 1;
        } else if (source.matched) {
          existing += 1;
        } else {
          skipped += 1;
        }
      }
      cursor = sources.at(-1)!.conversationId;
    }

    return {
      existing,
      migrated,
      missing,
      scanned,
      ...(skipped > 0 ? { skipped } : {}),
    };
  } finally {
    await closeExecutor?.();
  }
}

export const conversationUsageRepairMigration = {
  name: "repair-conversation-usage",
  run: repairConversationUsage,
};
