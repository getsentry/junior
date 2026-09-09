import type {
  PluginRegistration,
  PluginRunContext,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import { getSqlExecutor } from "@/chat/db";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { DEFAULT_BRIEF_PROMPT, defaultBriefModelId } from "./config";
import { briefUpdatedEvent } from "./events";
import { generateBrief, type BriefCompleteObject } from "./generate";
import { briefInputFromSql } from "./sql/input";
import { appendConversationBrief, readLatestConversationBrief } from "./store";

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
  if (!hasUserInstruction(run)) {
    logSkip(context, run.conversationId, "no_user_instruction");
    return;
  }

  await context.state.withLock(
    `brief:${run.conversationId}`,
    BRIEF_LOCK_TTL_MS,
    async () => {
      const db = context.db as JuniorDatabase;
      const previous = await readLatestConversationBrief(
        db,
        run.conversationId,
      );
      if (previous?.turnId === run.runId) {
        logSkip(context, run.conversationId, "turn_already_stored");
        return;
      }
      const { input, throughSeq } = await briefInputFromSql(
        executor,
        run.conversationId,
      );
      const modelId = await defaultBriefModelId();
      const completeObject: BriefCompleteObject = async ({
        modelId: _modelId,
        ...request
      }) => await context.model.completeObject(request);
      const generation = await generateBrief({
        completeObject,
        input,
        model: modelId,
        previous: previous?.content,
        prompt: DEFAULT_BRIEF_PROMPT,
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
      if (!stored.inserted) {
        logSkip(context, run.conversationId, "turn_already_stored");
        return;
      }
      await context.events.emit(
        briefUpdatedEvent({
          version: stored.value.version,
          modelId,
          ...(generation.costUsd !== undefined
            ? { costUsd: generation.costUsd }
            : undefined),
          decisions: generation.brief.decisions.length,
          openDecisions: generation.brief.openDecisions.length,
          links: generation.brief.links.length,
        }),
      );
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
  model: { structuredModel: "default" },
  conversationEvents: [briefUpdatedEvent],
  tasks: {
    updateBrief: {
      async run(context) {
        await updateConversationBrief(context);
      },
    },
  },
};
