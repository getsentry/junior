/**
 * Heartbeat backfill of Conversation embeddings. A new embedding model
 * leaves every Conversation without a vector that search can compare, until
 * its next Brief. This run embeds the latest Brief of each such Conversation.
 *
 * A completed run marks the model done for an hour, so later heartbeats make
 * one state request instead of a scan of every Brief. A run that hits its
 * budget leaves only its claim, which expires before a later heartbeat
 * continues. The backfill skips stored vectors, so runs can overlap safely.
 *
 * Attributes on the `conversation_embeddings.backfill` span:
 * - `app.conversation_embeddings.backfill.embedded.count`: Briefs embedded.
 * - `app.conversation_embeddings.backfill.outcome`: `completed` when no
 *   Brief was left, else `budget_exceeded`.
 * Policy: policies/observability.md.
 */
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { backfillConversationEmbeddings } from "./embedding";

const BACKFILL_BUDGET_MS = 10_000;
const BACKFILL_CLAIM_TTL_MS = 60_000;
const BACKFILL_DONE_TTL_MS = 60 * 60 * 1_000;

/** Embed the latest Briefs that have no vector of the embedder's model. */
export async function runConversationEmbeddingBackfill(
  embedder: PluginEmbedder,
): Promise<void> {
  const key = `junior:conversation_embeddings:backfill:${embedder.provider}:${embedder.model}`;
  const state = getStateAdapter();
  if (!(await state.setIfNotExists(key, "running", BACKFILL_CLAIM_TTL_MS))) {
    return;
  }
  await withSpan(
    "conversation_embeddings.backfill",
    "conversation_embeddings.backfill",
    {},
    async (setSpanAttributes) => {
      const result = await backfillConversationEmbeddings({
        db: getDb(),
        // Earlier heartbeat phases use part of the heartbeat, so the budget
        // starts now.
        deadlineMs: Date.now() + BACKFILL_BUDGET_MS,
        embedder,
      });
      if (result.done) {
        await state.set(key, "done", BACKFILL_DONE_TTL_MS);
      }
      setSpanAttributes({
        "app.conversation_embeddings.backfill.embedded.count": result.embedded,
        "app.conversation_embeddings.backfill.outcome": result.done
          ? "completed"
          : "budget_exceeded",
      });
    },
  );
}
