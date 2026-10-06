import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import type { ConversationEvent } from "@/chat/conversations/history";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import { logInfo, setSpanAttributes } from "@/chat/logging";
import type { ModelProfile } from "@/chat/model-profile";
import {
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import { COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { appendOpenPlan } from "@/chat/services/plan-continuation";
import { escapeXml } from "@/chat/xml";
import { expectedContextCalls, shouldUseDistillations } from "./economics";
import { activeDistillations, estimateModelVisibleTokens } from "./history";

interface PendingInstruction {
  message: PiMessage;
  provenance: ConversationMessageProvenance;
}

function rawCacheWarm(
  events: readonly ConversationEvent[],
  modelId: string,
): boolean {
  const last = [...events]
    .reverse()
    .find((event) => event.data.type === "assistant_message");
  if (!last || last.data.type !== "assistant_message") return true;
  const model = last.data.model;
  const provider = last.data.provider;
  const previousModelId =
    typeof model === "string"
      ? model.includes("/") || !provider
        ? model
        : `${provider}/${model}`
      : undefined;
  // A cold write on the previous call can warm the next call. Count the same
  // model's prefix as warm unless a model switch proves otherwise.
  return previousModelId === undefined || previousModelId === modelId;
}

/** Use stored observations at a new Turn only when their cold write pays off. */
export async function compactWithDistillations(args: {
  conversationId: string;
  modelId: string;
  modelProfile: ModelProfile;
  messages: PiMessage[];
  pendingInstruction: PendingInstruction;
  signal?: AbortSignal;
}): Promise<PiMessage[] | undefined> {
  const store = getConversationEventStore();
  const events = await store.loadCurrentHistory(args.conversationId);
  const distillations = activeDistillations(events);
  if (distillations.length === 0) return undefined;
  const throughSeq = distillations.at(-1)!.data.throughSeq;
  const projection = await loadConversationProjection({
    conversationId: args.conversationId,
  });
  const source = [...args.messages, args.pendingInstruction.message];
  if (
    projection.messages.length !== source.length ||
    !isDeepStrictEqual(
      stripRuntimeTurnContext(projection.messages),
      stripRuntimeTurnContext(source),
    )
  ) {
    return undefined;
  }
  const instructionIndex = projection.messages.length - 1;
  if (
    projection.seqs[instructionIndex]! <= throughSeq ||
    projection.provenance[instructionIndex]?.authority !== "instruction" ||
    !isDeepStrictEqual(
      projection.provenance[instructionIndex],
      args.pendingInstruction.provenance,
    )
  ) {
    return undefined;
  }
  const summary = appendOpenPlan(
    [
      COMPACTION_SUMMARY_PREFIX,
      '<thread-context authority="evidence-only">',
      ...distillations.map((event) => escapeXml(event.data.observations)),
      "</thread-context>",
    ].join("\n"),
    source,
  );
  const summaryMessage: PiMessage = {
    role: "user",
    content: [{ type: "text", text: summary }],
    timestamp: Date.now(),
  };
  const replacement: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
    sourceEventSeq?: number;
  }> = [
    { message: summaryMessage, provenance: contextProvenance },
    ...projection.messages.flatMap((message, index) =>
      projection.seqs[index]! > throughSeq
        ? [
            {
              message,
              provenance: projection.provenance[index]!,
              sourceEventSeq: projection.seqs[index],
            },
          ]
        : [],
    ),
  ];
  const messages = replacement.map((entry) => entry.message);
  const rawTokens = estimateModelVisibleTokens(source);
  const replacementTokens = estimateModelVisibleTokens(messages);
  const futureCalls = expectedContextCalls(events);
  const priced = shouldUseDistillations({
    model: resolveGatewayModel(args.modelId),
    rawTokens,
    replacementTokens,
    expectedCalls: futureCalls,
    rawCacheWarm: rawCacheWarm(events, args.modelId),
    workerCostUsd: events
      .filter((event) => event.data.type === "distillation")
      .reduce(
        (sum, event) =>
          sum + (event.data.type === "distillation" ? event.data.costUsd : 0),
        0,
      ),
  });
  if (
    replacementTokens >= getAgentContextInputLimitTokens(args.modelId) ||
    (!priced &&
      rawTokens < getAgentContextCompactionTriggerTokens(args.modelId))
  ) {
    logInfo("conversation.distillation.skipped", {
      "gen_ai.conversation.id": args.conversationId,
      "app.distillation.stage": "replacement",
      "app.distillation.reason":
        replacementTokens >= getAgentContextInputLimitTokens(args.modelId)
          ? "input_limit"
          : "not_economical",
      "app.distillation.raw_tokens": rawTokens,
      "app.distillation.replacement_tokens": replacementTokens,
      "app.distillation.expected_calls": futureCalls,
    });
    return undefined;
  }

  args.signal?.throwIfAborted();
  await store.replaceHistory(args.conversationId, {
    createdAtMs: Date.now(),
    data: {
      type: "compaction",
      modelProfile: args.modelProfile,
      modelId: args.modelId,
      summary,
      details: {
        reason: "distillation",
        throughSeq,
        estimatedInputTokens: rawTokens,
        replacementInputTokens: replacementTokens,
        expectedCalls: futureCalls,
        priced,
      },
      replacementHistory: replacement.map((entry) => ({
        item: historyItemFromPiMessage(entry.message, entry.provenance),
        ...(entry.sourceEventSeq === undefined
          ? undefined
          : { sourceEventSeq: entry.sourceEventSeq }),
      })),
    },
  });
  setSpanAttributes({
    "app.compaction.reason": "distillation",
    "app.compaction.distillation_through_seq": throughSeq,
    "app.compaction.input_messages": source.length,
    "app.compaction.replacement_tokens": replacementTokens,
    "app.context_tokens_estimated": rawTokens,
  });
  return messages;
}
