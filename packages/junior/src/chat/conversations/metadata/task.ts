import { and, desc, eq, gt, sql } from "drizzle-orm";
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

// The holder extends the lock while it works, so a crashed holder frees it
// within this TTL, before the queue retries the crashed task.
const LOCK_TTL_MS = 60 * 1_000;
// The holder covers newer Turns before it releases the lock, so a task that
// finds the lock held can skip. The wait covers only the gap between the
// holder's last check and its release.
const LOCK_WAIT_MS = 5_000;
// Bounds how many updates one holder stores before it releases the lock.
const MAX_PASSES = 3;
// Bounds how many newer completed Turns catch-up reads to find one that
// needs metadata.
const CATCH_UP_TURN_LIMIT = 20;

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

/** Return the Turn's reason to get no metadata, if it has one. */
async function turnSkipReason(
  conversationId: string,
  record: TurnRecord,
): Promise<string | undefined> {
  // TODO(dcramer): Remove the routing Source fallback after every deployed
  // Turn cursor stores Source.
  const source =
    record.source ??
    (await resolveConversationRouting({ conversationId }))?.source;
  if (!source) {
    throw new Error(`Completed Turn ${record.turnId} is missing Source`);
  }
  if (
    source.kind !== "slack" &&
    source.kind !== "web" &&
    source.kind !== "local"
  ) {
    return "unsupported_source";
  }
  if (!hasUserInstruction(record)) return "no_user_instruction";
  return undefined;
}

/**
 * Return the newest Turn that completed after `afterSeq` and needs metadata.
 * Turns whose own task skips them on purpose do not count.
 */
async function readNewerTurnNeedingMetadata(
  db: JuniorDatabase,
  conversationId: string,
  afterSeq: number,
): Promise<{ terminalSeq: number; turnId: string } | undefined> {
  const rows = await db
    .select({
      seq: juniorConversationEvents.seq,
      turnId: sql<string>`${juniorConversationEvents.payload}->>'turnId'`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "turn_completed"),
        gt(juniorConversationEvents.seq, afterSeq),
      ),
    )
    .orderBy(desc(juniorConversationEvents.seq))
    .limit(CATCH_UP_TURN_LIMIT);
  /* oxlint-disable no-await-in-loop -- Newest first: stop at the first Turn that needs metadata. CATCH_UP_TURN_LIMIT caps the loop. */
  for (const row of rows) {
    const record = await getTurnRecord(conversationId, row.turnId);
    if (record?.state !== "completed") continue;
    if ((await turnSkipReason(conversationId, record)) === undefined) {
      return { terminalSeq: row.seq, turnId: row.turnId };
    }
  }
  /* oxlint-enable no-await-in-loop */
  return undefined;
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
 * Store the metadata and embedding through one completed Turn unless newer
 * metadata already covers it. Returns the event seq that the metadata covers.
 */
async function storeMetadataThroughTurn(
  db: JuniorDatabase,
  executor: ReturnType<typeof getSqlExecutor>,
  args: { conversationId: string; terminalSeq: number; turnId: string },
): Promise<number> {
  const { conversationId, terminalSeq, turnId } = args;
  const embed = createConversationEmbedder({
    cost: { conversationId, turnId },
    operation: "conversation_embedding",
  });
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
    return previous.throughSeq;
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
    previous: previous?.summary ? { summary: previous.summary } : undefined,
  });
  const stored = await writeConversationMetadata(db, {
    conversationId,
    throughSeq: terminalSeq,
    ...generated,
  });
  if (!stored) {
    logSkip(conversationId, "turn_already_covered");
    return terminalSeq;
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
  return terminalSeq;
}

/**
 * Update the summary and Conversation embedding after one completed Turn.
 * Runs on the session-completed task queue, never on the reply path. A retry repeats only the steps that did not finish.
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
  const skipReason = await turnSkipReason(conversationId, record);
  if (skipReason) {
    logSkip(conversationId, skipReason);
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

  const state = getStateAdapter();
  await state.connect();
  const locked = await withLock(
    state,
    `conversation_metadata:${conversationId}`,
    async () => {
      const db = getDb();
      let turn = {
        terminalSeq: await readTurnCompletedSeq(db, conversationId, turnId),
        turnId,
      };
      /* oxlint-disable no-await-in-loop -- Each pass needs the metadata that the pass before stored. MAX_PASSES caps the loop. */
      for (let pass = 1; ; pass++) {
        const throughSeq = await storeMetadataThroughTurn(db, executor, {
          conversationId,
          ...turn,
        });
        // A newer Turn that found this lock held skipped its update. Cover
        // it now, or a Conversation that goes quiet keeps stale metadata.
        const latest = await readNewerTurnNeedingMetadata(
          db,
          conversationId,
          throughSeq,
        );
        if (!latest) return;
        if (pass >= MAX_PASSES) {
          // That Turn's own task already skipped. Fail so the queue retries
          // this task, which goes straight to the newest Turn.
          throw new Error(
            `Conversation metadata catch-up stopped after ${MAX_PASSES} passes with Turn ${latest.turnId} uncovered in Conversation ${conversationId}`,
          );
        }
        turn = latest;
      }
      /* oxlint-enable no-await-in-loop */
    },
    { keepAlive: true, ttlMs: LOCK_TTL_MS, waitMs: LOCK_WAIT_MS },
  );
  if (!locked.acquired) {
    logSkip(conversationId, "update_in_progress");
  }
}
