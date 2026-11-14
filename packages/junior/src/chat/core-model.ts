/**
 * Core model calls with required cost attribution.
 *
 * Core code calls the text, object, decision, and embedding models only
 * through this module. Each call names its operation and where its cost
 * goes, so a new call site cannot drop its cost. Plugins get the same rule
 * through `chat/plugins/model.ts`.
 */
import type { ZodTypeAny } from "zod";
import type * as z from "zod";
import { getConversationEventStore } from "@/chat/db";
import { JUNIOR_NATIVE_EVENT_NAMESPACE } from "@/chat/conversations/structured-events";
import { extractGenAiUsageSummary, runBestEffort } from "@/chat/logging";
import * as gateway from "@/chat/pi/client";
import { agentTurnCostUsd } from "@/chat/usage";

// These operations store `costUsd` on their own event: `brief_updated`,
// `action_decided` (Guardian), and `passive_reply_routed`.
type CallerRecordedOperation =
  | "brief_update"
  | "guardian_action_review"
  | "passive_reply_route";

// The name of the cost event in the `junior` namespace. Conversation cost
// and the dashboard usage breakdown read these events.
type ConversationRecordedOperation =
  | "cache_warmup"
  | "conversation_catch_up"
  | "conversation_embedding"
  | "conversation_search_embedding"
  | "conversation_title"
  | "image_prompt_enrichment"
  | "review_item_reply_match"
  | "run_title"
  | "task_title"
  | "tool_search_rerank"
  | "vision_summary";

/** No Conversation exists, such as an eval. The cost stays on the span. */
type NoConversation = { owner: "none" };

/**
 * The Conversation that pays for a call. The host appends one cost event to
 * it for each priced call.
 */
export type ConversationModelCost =
  | { conversationId: string; turnId?: string }
  | NoConversation;

/** The operation of one core model call and where its cost goes. */
type ModelCallAttribution =
  | { operation: ConversationRecordedOperation; cost: ConversationModelCost }
  | {
      operation: CallerRecordedOperation;
      /** `caller`: the caller stores the returned cost on its own event. */
      cost: { owner: "caller" } | NoConversation;
    };

type Attributed<TParams> = Omit<TParams, "promptName"> & ModelCallAttribution;

function gatewayParams<TParams extends ModelCallAttribution>(
  params: TParams,
): Omit<TParams, "cost" | "operation"> & { promptName: string } {
  const { cost: _cost, operation, ...rest } = params;
  return { ...rest, promptName: `junior.${operation}` };
}

async function recordCost(
  attribution: ModelCallAttribution,
  costUsd: number | undefined,
): Promise<void> {
  const { cost, operation } = attribution;
  if (costUsd === undefined || !("conversationId" in cost)) return;
  // A failed write is logged, not thrown, so it cannot discard a model
  // result that already succeeded.
  await runBestEffort(
    async () => {
      await getConversationEventStore().append(
        cost.conversationId,
        [
          {
            createdAtMs: Date.now(),
            data: {
              type: "structured_event",
              namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
              name: operation,
              version: 1,
              ...(cost.turnId ? { turnId: cost.turnId } : undefined),
              content: { costUsd },
            },
          },
        ],
        { activity: "preserve" },
      );
    },
    "model_cost.record.failed",
    { "gen_ai.prompt.name": `junior.${operation}` },
  );
}

/** Run a text completion and attribute its cost. */
export async function completeText(
  params: Attributed<Parameters<typeof gateway.completeText>[0]>,
): Promise<Awaited<ReturnType<typeof gateway.completeText>>> {
  const result = await gateway.completeText(gatewayParams(params));
  await recordCost(
    params,
    agentTurnCostUsd(extractGenAiUsageSummary(result.message)),
  );
  return result;
}

/** Run a schema-constrained completion and attribute its cost. */
export async function completeObject<TSchema extends ZodTypeAny>(
  params: Attributed<Parameters<typeof gateway.completeObject<TSchema>>[0]>,
): Promise<{ costUsd?: number; object: z.infer<TSchema> }> {
  const result = await gateway.completeObject<TSchema>(gatewayParams(params));
  await recordCost(params, result.costUsd);
  return result;
}

/** Answer decision questions and attribute the cost. */
export async function completeDecision<
  const TQuestions extends Parameters<
    typeof gateway.completeDecision
  >[0]["questions"],
>(
  params: Attributed<
    Parameters<typeof gateway.completeDecision<TQuestions>>[0]
  >,
): Promise<Awaited<ReturnType<typeof gateway.completeDecision<TQuestions>>>> {
  const result = await gateway.completeDecision<TQuestions>(
    gatewayParams(params),
  );
  await recordCost(params, result.costUsd);
  return result;
}

/** Embed texts with the configured embedding model and attribute the cost. */
export async function embedTexts(
  params: Omit<Parameters<typeof gateway.embedTexts>[0], "metadata"> &
    ModelCallAttribution,
): Promise<Awaited<ReturnType<typeof gateway.embedTexts>>> {
  const { cost, operation: _operation, ...rest } = params;
  const result = await gateway.embedTexts({
    ...rest,
    ...("conversationId" in cost
      ? { metadata: { conversationId: cost.conversationId } }
      : undefined),
  });
  await recordCost(params, result.costUsd);
  return result;
}
