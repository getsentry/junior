import { and, desc, eq, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import { botConfig } from "@/chat/config";
import {
  createConversationEmbedder,
  storeConversationEmbedding,
} from "@/chat/conversations/embedding";
import { hasConversationMetadata } from "@/chat/conversations/kind-behavior";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { completeObject } from "@/chat/core-model";
import { getDb, getSqlExecutor } from "@/chat/db";
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
import { generateConversationMetadata } from "./generate";
import { conversationMetadataInputFromSql } from "./input";
import { readConversationMetadata, writeConversationMetadata } from "./store";

/**
 * Queue identity of the metadata task on the session-completed task queue.
 * No plugin has this name, so it cannot collide with a plugin task.
 */
export const CONVERSATION_METADATA_TASK = {
  plugin: "junior",
  name: "updateConversationMetadata",
} as const;

const LOCK_TTL_MS = 10 * 60 * 1_000;

let enabled = false;

/** Replace the app-level metadata setting and return the previous one. */
export function setConversationMetadataEnabled(next: boolean): boolean {
  const previous = enabled;
  enabled = next;
  return previous;
}

/** Return whether Turns update Conversation metadata. */
export function isConversationMetadataEnabled(): boolean {
  return enabled;
}

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
  logInfo("conversation_metadata.update.skipped", {
    "app.conversation_metadata.skip_reason": reason,
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
 * Update the summary, outcome status, and Conversation embedding after one
 * completed Turn. Runs on the session-completed task queue, never on the
 * reply path. A retry repeats only the steps that did not finish.
 */
export async function updateConversationMetadata(args: {
  conversationId: string;
  turnId: string;
}): Promise<void> {
  const { conversationId, turnId } = args;
  const record = await getTurnRecord(conversationId, turnId);
  if (record?.state !== "completed") {
    throw new Error(`Turn ${turnId} is not completed for its metadata`);
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
  if (conversation && !hasConversationMetadata(conversation.kind)) {
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
    `conversation_metadata:${conversationId}`,
    async () => {
      const db = getDb();
      const embed = createConversationEmbedder({
        cost: { conversationId, turnId },
        operation: "conversation_embedding",
      });
      const terminalSeq = await readTurnCompletedSeq(
        db,
        conversationId,
        turnId,
      );
      const previous = await readConversationMetadata(db, conversationId);
      if (
        previous?.throughSeq !== undefined &&
        previous.throughSeq >= terminalSeq
      ) {
        // A retry after the metadata write embeds again here. The embedding
        // write skips a vector that is already current.
        await storeConversationEmbedding(db, embed, {
          conversationId,
          metadata: previous,
        });
        logSkip(conversationId, "turn_already_covered");
        return;
      }
      const input = await conversationMetadataInputFromSql(
        executor,
        conversationId,
        terminalSeq,
      );
      // The update runs after the reply and shares no prompt prefix with the
      // Turn, so the main model's cache cannot help.
      const modelId = botConfig.fastModelId;
      const generated = await generateConversationMetadata({
        completeObject: (request) =>
          completeObject({
            ...request,
            modelId,
            operation: "conversation_metadata",
            cost: { conversationId, turnId },
          }),
        input,
        previous: previous?.summary
          ? {
              summary: previous.summary,
              ...(previous.outcomeStatus
                ? { outcomeStatus: previous.outcomeStatus }
                : undefined),
            }
          : undefined,
      });
      const stored = await writeConversationMetadata(db, {
        conversationId,
        throughSeq: terminalSeq,
        ...generated,
      });
      if (!stored) {
        logSkip(conversationId, "turn_already_covered");
        return;
      }
      // The metadata is stored first, so an embedding failure cannot lose
      // it. The failure fails the task, and its retry embeds again above.
      await storeConversationEmbedding(db, embed, {
        conversationId,
        metadata: {
          ...generated,
          throughSeq: terminalSeq,
          ...(input.title ? { title: input.title } : undefined),
        },
      });
    },
    { ttlMs: LOCK_TTL_MS },
  );
  if (!locked.acquired) {
    // The queue retries the task after the current owner finishes.
    throw new Error(
      `Could not acquire the Conversation metadata lock for ${conversationId}`,
    );
  }
}
