import type {
  PluginConversationEvents,
  PluginRegistration,
  PluginRunContext,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { and, desc, eq, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents } from "@/db/schema";
import { botConfig } from "@/chat/config";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getSqlExecutor } from "@/chat/db";
import { completeObject } from "@/chat/core-model";
import { pluginTaskId } from "@/chat/plugins/task-queue";
import {
  createConversationEmbedder,
  storeConversationEmbedding,
} from "@/chat/conversations/embedding";
import { briefUpdatedEvent, briefUpdatedEventV1 } from "./events";
import { generateBrief } from "./generate";
import { briefInputFromSql } from "./input";
import { buildBriefsOperationalReport } from "./operational-report";
import { BRIEF_PROMPT } from "./prompt";
import {
  appendConversationBrief,
  readConversationBriefForTurn,
  readLatestConversationBrief,
  type ConversationBriefVersion,
} from "./store";

const BRIEF_LOCK_TTL_MS = 10 * 60 * 1_000;
// The holder covers newer Turns before it releases the lock, so a Turn that
// finds the lock held can skip. The wait only covers the gap between the
// holder's last check and its release.
const BRIEF_LOCK_WAIT_MS = 5_000;
// Bounds how many newer Turns one holder catches up before it releases.
const BRIEF_MAX_PASSES = 3;

function hasUserInstruction(run: PluginRunContext): boolean {
  return run.transcript.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "user" &&
      entry.provenance?.authority === "instruction",
  );
}

function logSkip(
  context: PluginTaskContext,
  conversationId: string,
  reason: string,
): void {
  context.log.info("Brief update skipped", { conversationId, reason });
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

async function readLatestCompletedTurn(
  db: JuniorDatabase,
  conversationId: string,
): Promise<{ seq: number; turnId: string } | undefined> {
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
      ),
    )
    .orderBy(desc(juniorConversationEvents.seq))
    .limit(1);
  return rows[0];
}

async function emitBriefUpdated(
  events: PluginConversationEvents,
  stored: ConversationBriefVersion,
): Promise<void> {
  await events.emit(
    briefUpdatedEvent({
      version: stored.version,
      modelId: stored.modelId,
      ...(stored.costUsd !== undefined
        ? { costUsd: stored.costUsd }
        : undefined),
      decisions: stored.content.decisions.length,
      links: stored.content.links.length,
    }),
  );
}

/** Generate and store the next Brief after one completed Turn. */
export async function updateConversationBrief(
  context: PluginTaskContext,
): Promise<void> {
  const run = await context.run.load();
  if (
    run.source.kind !== "slack" &&
    run.source.kind !== "web" &&
    run.source.kind !== "local"
  ) {
    logSkip(context, run.conversationId, "unsupported_source");
    return;
  }
  const executor = getSqlExecutor();
  const conversation = await createSqlStore(executor).get({
    conversationId: run.conversationId,
  });
  if (conversation?.kind === "task") {
    logSkip(context, run.conversationId, "task_conversation");
    return;
  }
  if (conversation?.transcriptPurgedAtMs !== undefined) {
    const root = await resolveRootVisibility(executor, run.conversationId);
    if (root.visibility !== "public") {
      logSkip(context, run.conversationId, "purged_private");
      return;
    }
  }
  if (!hasUserInstruction(run)) {
    logSkip(context, run.conversationId, "no_user_instruction");
    return;
  }

  const db = context.db as JuniorDatabase;
  const attempt = await context.state.withLock(
    `brief:${run.conversationId}`,
    BRIEF_LOCK_TTL_MS,
    async () => {
      let turn = { events: context.events, turnId: run.runId };
      /* oxlint-disable no-await-in-loop -- Each pass needs the Brief that the pass before stored. BRIEF_MAX_PASSES caps the loop. */
      for (let pass = 1; ; pass++) {
        const throughSeq = await storeBriefForTurn(context, {
          conversationId: run.conversationId,
          db,
          events: turn.events,
          executor,
          turnId: turn.turnId,
        });
        // A newer Turn that found this lock held skipped its Brief, and each
        // Brief covers only events through its own Turn. Cover it now, or a
        // Conversation that goes quiet keeps a stale Brief. This also covers a
        // newer Turn without a user instruction, which costs one Brief.
        const latest = await readLatestCompletedTurn(db, run.conversationId);
        if (!latest || latest.seq <= throughSeq) return;
        if (pass >= BRIEF_MAX_PASSES) {
          logSkip(context, run.conversationId, "catch_up_limit");
          return;
        }
        turn = {
          events: await briefTaskEvents(run.conversationId, latest.turnId),
          turnId: latest.turnId,
        };
      }
      /* oxlint-enable no-await-in-loop */
    },
    { waitMs: BRIEF_LOCK_WAIT_MS },
  );
  if (!attempt.acquired) {
    logSkip(context, run.conversationId, "brief_in_progress");
  }
}

/**
 * Write events as the Brief task of another Turn would, so its own task run
 * later finds the same event instead of adding a second one.
 */
async function briefTaskEvents(
  conversationId: string,
  turnId: string,
): Promise<PluginConversationEvents> {
  // Loaded on use: the event writer imports this module's registration.
  const { createPluginConversationEvents } =
    await import("@/chat/plugins/conversation-events");
  return createPluginConversationEvents({
    conversationId,
    operationId: pluginTaskId({
      name: "updateBrief",
      params: { conversationId, sessionId: turnId },
      plugin: briefsTaskRegistration.manifest.name,
    }),
    plugin: briefsTaskRegistration,
    turnId,
  });
}

/**
 * Store the Brief for one completed Turn unless a Brief already covers it.
 * Returns the last event seq that the newest Brief covers.
 */
async function storeBriefForTurn(
  context: PluginTaskContext,
  args: {
    conversationId: string;
    db: JuniorDatabase;
    events: PluginConversationEvents;
    executor: ReturnType<typeof getSqlExecutor>;
    turnId: string;
  },
): Promise<number> {
  const { conversationId, db, events, executor, turnId } = args;
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
    // The event writer uses the stable task operation id, so this repairs a
    // failed first emission without adding a second event on normal retries.
    await emitBriefUpdated(events, existing);
    await storeConversationEmbedding(db, embed, existing);
    logSkip(context, conversationId, "turn_already_stored");
    return existing.throughSeq;
  }
  const terminalSeq = await readTurnCompletedSeq(db, conversationId, turnId);
  const previous = await readLatestConversationBrief(db, conversationId);
  if (previous && previous.throughSeq >= terminalSeq) {
    logSkip(context, conversationId, "turn_already_covered");
    return previous.throughSeq;
  }
  const input = await briefInputFromSql(executor, conversationId, terminalSeq);
  // Same request as `junior briefs run`, so the tuned prompt applies in
  // production. Briefs run after the reply and share no prompt prefix
  // with the Turn, so the main model's cache cannot help.
  const modelId = botConfig.fastModelId;
  const generation = await generateBrief({
    assistantName: botConfig.userName,
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
  await emitBriefUpdated(events, stored.value);
  // The Brief is stored first, so an embedding failure cannot lose it.
  // The failure fails the task, and its retry takes the
  // `turn_already_stored` path above and embeds again.
  await storeConversationEmbedding(db, embed, stored.value);
  if (!stored.inserted) {
    logSkip(context, conversationId, "turn_already_stored");
  }
  return stored.value.throughSeq;
}

/** Core task registration kept outside the installed plugin catalog. */
export const briefsTaskRegistration: PluginRegistration = {
  manifest: {
    name: "briefs",
    displayName: "Briefs",
    description: "Durable Conversation Brief generation",
  },
  conversationEvents: [briefUpdatedEventV1, briefUpdatedEvent],
  hooks: {
    async operationalReport(context) {
      const briefDays = await context.eventStats.costsByDay({
        days: 90,
        eventName: "brief_updated",
      });
      return await buildBriefsOperationalReport({
        briefDays,
        db: context.db as JuniorDatabase,
        nowMs: context.nowMs,
      });
    },
  },
  tasks: {
    updateBrief: {
      async run(context) {
        await updateConversationBrief(context);
      },
    },
  },
};
