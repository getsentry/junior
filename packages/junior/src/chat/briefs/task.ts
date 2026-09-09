import type {
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
import { defaultModelId } from "@/chat/model-profile";
import { completeObject } from "@/chat/pi/client";
import { briefUpdatedEvent } from "./events";
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

async function emitBriefUpdated(
  context: PluginTaskContext,
  stored: ConversationBriefVersion,
): Promise<void> {
  await context.events.emit(
    briefUpdatedEvent({
      version: stored.version,
      modelId: stored.modelId,
      ...(stored.costUsd !== undefined
        ? { costUsd: stored.costUsd }
        : undefined),
      decisions: stored.content.decisions.length,
      openDecisions: stored.content.openDecisions.length,
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
  if (conversation?.parentConversationId) {
    logSkip(context, run.conversationId, "child_conversation");
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

  await context.state.withLock(
    `brief:${run.conversationId}`,
    BRIEF_LOCK_TTL_MS,
    async () => {
      const db = context.db as JuniorDatabase;
      const existing = await readConversationBriefForTurn(
        db,
        run.conversationId,
        run.runId,
      );
      if (existing) {
        // The event writer uses the stable task operation id, so this repairs a
        // failed first emission without adding a second event on normal retries.
        await emitBriefUpdated(context, existing);
        logSkip(context, run.conversationId, "turn_already_stored");
        return;
      }
      const terminalSeq = await readTurnCompletedSeq(
        db,
        run.conversationId,
        run.runId,
      );
      const previous = await readLatestConversationBrief(
        db,
        run.conversationId,
      );
      if (previous && previous.throughSeq >= terminalSeq) {
        logSkip(context, run.conversationId, "turn_already_covered");
        return;
      }
      const { input, throughSeq } = await briefInputFromSql(
        executor,
        run.conversationId,
      );
      // Same request as `junior briefs run`, so the tuned prompt and
      // temperature apply in production.
      const modelId = defaultModelId(botConfig);
      const generation = await generateBrief({
        completeObject: (request) =>
          completeObject({
            ...request,
            modelId,
            promptName: "junior.brief_update",
          }),
        input,
        previous: previous?.content,
        prompt: BRIEF_PROMPT,
        throughIndex: throughSeq,
      });
      const stored = await appendConversationBrief(db, {
        conversationId: run.conversationId,
        turnId: run.runId,
        throughSeq,
        content: generation.brief,
        searchText: generation.searchText,
        modelId,
        ...(generation.costUsd !== undefined
          ? { costUsd: generation.costUsd }
          : undefined),
      });
      await emitBriefUpdated(context, stored.value);
      if (!stored.inserted) {
        logSkip(context, run.conversationId, "turn_already_stored");
      }
    },
  );
}

/** Core task registration kept outside the installed plugin catalog. */
export const briefsTaskRegistration: PluginRegistration = {
  manifest: {
    name: "briefs",
    displayName: "Briefs",
    description: "Durable Conversation Brief generation",
  },
  conversationEvents: [briefUpdatedEvent],
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
