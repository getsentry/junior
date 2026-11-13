import { and, desc, eq, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import { botConfig } from "@/chat/config";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getDb, getSqlExecutor } from "@/chat/db";
import { completeObject } from "@/chat/core-model";
import {
  createConversationEmbedder,
  storeConversationEmbedding,
} from "@/chat/conversations/embedding";
import { logInfo } from "@/chat/logging";
import {
  getUserMessageInstructionText,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { resolveConversationRouting } from "@/chat/services/turn-session-routing";
import { getStateAdapter } from "@/chat/state/adapter";
import { withLock } from "@/chat/state/locks";
import {
  getTurnRecord,
  type TurnRecord,
} from "@/chat/task-execution/checkpoint";
import { appendBriefUpdatedEvent } from "./events";
import { generateBrief } from "./generate";
import { briefInputFromSql } from "./input";
import { BRIEF_PROMPT } from "./prompt";
import {
  appendConversationBrief,
  readConversationBriefForTurn,
  readLatestConversationBrief,
} from "./store";

/**
 * Queue identity of the Brief task. It rides the session-completed task queue
 * and predates core Briefs, so in-flight messages and task ids stay valid.
 */
export const BRIEF_TASK = { plugin: "briefs", name: "updateBrief" } as const;

const BRIEF_LOCK_TTL_MS = 10 * 60 * 1_000;

/** Return whether a user gave this Turn an instruction. */
function hasUserInstruction(record: TurnRecord): boolean {
  const start = record.turnStartMessageIndex ?? 0;
  return record.piMessages
    .slice(start)
    .some(
      (message, offset) =>
        record.piMessageProvenance[start + offset]?.authority ===
          "instruction" &&
        stripRuntimeTurnContext([message]).some(
          (stripped) => getUserMessageInstructionText(stripped) !== "",
        ),
    );
}

function logSkip(conversationId: string, reason: string): void {
  logInfo("brief.update.skipped", {
    "app.brief.skip_reason": reason,
    "gen_ai.conversation.id": conversationId,
  });
}

async function readTurnCompletedSeq(
  db: JuniorDatabase,
  conversationId: string,
  turnId: string,
): Promise<number> {
  const rows = await db
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "turn_completed"),
        sql`${juniorConversationEvents.payload}->>'turnId' = ${turnId}`,
      ),
    )
    .orderBy(desc(juniorConversationEvents.seq))
    .limit(1);
  const seq = rows[0]?.seq;
  if (seq === undefined) {
    throw new Error(
      `Completed Turn ${turnId} has no terminal event in Conversation ${conversationId}`,
    );
  }
  return seq;
}

/**
 * Generate and store the next Brief after one completed Turn. `operationId`
 * is the stable task id that makes the `brief_updated` event idempotent.
 */
export async function updateConversationBrief(args: {
  conversationId: string;
  operationId: string;
  turnId: string;
}): Promise<void> {
  const { conversationId, turnId } = args;
  const record = await getTurnRecord(conversationId, turnId);
  if (record?.state !== "completed") {
    throw new Error(`Turn ${turnId} is not completed for its Brief`);
  }
  // TODO(dcramer): Remove the routing Source fallback after every deployed
  // Turn cursor stores Source.
  const source =
    record.source ??
    (await resolveConversationRouting({ conversationId }))?.source;
  if (!source) {
    throw new Error(`Completed Turn ${turnId} is missing Source`);
  }
  if (
    source.kind !== "slack" &&
    source.kind !== "web" &&
    source.kind !== "local"
  ) {
    logSkip(conversationId, "unsupported_source");
    return;
  }
  const executor = getSqlExecutor();
  const conversation = await createSqlStore(executor).get({ conversationId });
  if (conversation?.kind === "task") {
    logSkip(conversationId, "task_conversation");
    return;
  }
  if (conversation?.transcriptPurgedAtMs !== undefined) {
    const root = await resolveRootVisibility(executor, conversationId);
    if (root.visibility !== "public") {
      logSkip(conversationId, "purged_private");
      return;
    }
  }
  if (!hasUserInstruction(record)) {
    logSkip(conversationId, "no_user_instruction");
    return;
  }

  const state = getStateAdapter();
  await state.connect();
  const locked = await withLock(
    state,
    `briefs:conversation:${conversationId}`,
    async () => {
      const db = getDb();
      const embed = createConversationEmbedder({
        cost: { conversationId, turnId },
        operation: "conversation_embedding",
      });
      const existing = await readConversationBriefForTurn(
        db,
        conversationId,
        turnId,
      );
      if (existing) {
        // The event key uses the stable task operation id, so this repairs a
        // failed first append without adding a second event on normal retries.
        await appendBriefUpdatedEvent({
          operationId: args.operationId,
          stored: existing,
        });
        await storeConversationEmbedding(db, embed, existing);
        logSkip(conversationId, "turn_already_stored");
        return;
      }
      const terminalSeq = await readTurnCompletedSeq(
        db,
        conversationId,
        turnId,
      );
      const previous = await readLatestConversationBrief(db, conversationId);
      if (previous && previous.throughSeq >= terminalSeq) {
        logSkip(conversationId, "turn_already_covered");
        return;
      }
      const input = await briefInputFromSql(
        executor,
        conversationId,
        terminalSeq,
      );
      // Same request as `junior briefs run`, so the tuned prompt applies in
      // production. Briefs run after the reply and share no prompt prefix
      // with the Turn, so the main model's cache cannot help.
      const modelId = botConfig.fastModelId;
      const generation = await generateBrief({
        completeObject: (request) =>
          completeObject({
            ...request,
            modelId,
            operation: "brief_update",
            // `brief_updated` stores the cost.
            cost: { owner: "caller" },
          }),
        input,
        previous: previous?.content,
        prompt: BRIEF_PROMPT,
        throughIndex: terminalSeq,
      });
      const stored = await appendConversationBrief(db, {
        conversationId,
        turnId,
        throughSeq: terminalSeq,
        content: generation.brief,
        searchText: generation.searchText,
        modelId,
        ...(generation.costUsd !== undefined
          ? { costUsd: generation.costUsd }
          : undefined),
      });
      await appendBriefUpdatedEvent({
        operationId: args.operationId,
        stored: stored.value,
      });
      // The Brief is stored first, so an embedding failure cannot lose it.
      // The failure fails the task, and its retry takes the
      // `turn_already_stored` path above and embeds again.
      await storeConversationEmbedding(db, embed, stored.value);
      if (!stored.inserted) {
        logSkip(conversationId, "turn_already_stored");
      }
    },
    { ttlMs: BRIEF_LOCK_TTL_MS },
  );
  if (!locked.acquired) {
    // The queue retries the task after the current owner finishes.
    throw new Error(`Could not acquire the Brief lock for ${conversationId}`);
  }
}
