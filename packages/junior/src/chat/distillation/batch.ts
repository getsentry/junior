import { createHash } from "node:crypto";
import { createGatewayProvider } from "@ai-sdk/gateway-batch";
import {
  APICallError,
  experimental_getBatchResults as getBatchResults,
  experimental_getBatchStatus as getBatchStatus,
  experimental_startBatch as startBatch,
  type Experimental_BatchReference as BatchReference,
} from "ai-batch";
import { resolveGatewayCredential } from "@/chat/pi/gateway-auth";
import { resolveGatewayModel } from "@/chat/pi/client";
import { estimateWorkerCost } from "./economics";

export const BATCH_MODEL_ID = "openai/gpt-6-luna";

export interface ObservationRequest {
  id: string;
  system: string;
  prompt: string;
}

function gateway(
  credential: Awaited<ReturnType<typeof resolveGatewayCredential>>,
) {
  return createGatewayProvider(credential ? { apiKey: credential.token } : {});
}

/** Submit a retry-safe Gateway batch without putting Conversation IDs in its key. */
export async function submitObservationBatch(args: {
  conversationId: string;
  historyVersion: number;
  requests: readonly ObservationRequest[];
}): Promise<BatchReference> {
  const idempotencyKey = createHash("sha256")
    .update(args.conversationId)
    .update("\0")
    .update(String(args.historyVersion))
    .update("\0")
    .update(args.requests.map((request) => request.id).join("\0"))
    .digest("hex");
  const batch = await startBatch({
    provider: gateway(await resolveGatewayCredential()),
    providerOptions: { gateway: { idempotencyKey } },
    requests: args.requests.map((request) => ({
      id: request.id,
      type: "text" as const,
      model: BATCH_MODEL_ID,
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: 4_096,
      reasoning: "none",
      temperature: 0,
    })),
  });
  return { version: batch.version, id: batch.id, provider: batch.provider };
}

/** Read one batch without waiting for provider completion. */
export async function observationBatchStatus(
  batch: BatchReference,
): Promise<"pending" | "completed" | "failed"> {
  const result = await getBatchStatus({
    provider: gateway(await resolveGatewayCredential()),
    batch,
  });
  return result.status;
}

/** Match results by request ID; never depend on the provider's result order. */
export async function observationBatchResults(
  batch: BatchReference,
  limit = 12,
): Promise<
  Array<{
    id: string;
    status: "succeeded" | "failed" | "cancelled" | "expired";
    text?: string;
    costUsd?: number;
    costEstimated?: boolean;
  }>
> {
  const results = [];
  const provider = gateway(await resolveGatewayCredential());
  const items = getBatchResults({
    provider,
    batch,
  });
  for await (const item of items) {
    if (results.length >= limit) {
      throw new Error("Observation batch returned too many results");
    }
    if (item.type !== "text") {
      throw new Error("Observation batch returned a non-text result");
    }
    if (item.status !== "succeeded") {
      results.push({ id: item.id, status: item.status });
      continue;
    }
    const inputTokens = item.usage.inputTokens;
    const outputTokens = item.usage.outputTokens;
    const billed = await (async () => {
      if (!item.response?.id) return undefined;
      try {
        const generation = await provider.getGenerationInfo({
          id: item.response.id,
        });
        return {
          costUsd:
            generation.totalCost +
            (generation.isByok ? generation.upstreamInferenceCost : 0),
          estimated: generation.isByok,
        };
      } catch (error) {
        if (APICallError.isInstance(error) && error.statusCode === 404) {
          return undefined;
        }
        throw error;
      }
    })();
    const costUsd =
      billed && Number.isFinite(billed.costUsd) && billed.costUsd >= 0
        ? billed.costUsd
        : inputTokens !== undefined && outputTokens !== undefined
          ? estimateWorkerCost({
              model: resolveGatewayModel(BATCH_MODEL_ID),
              inputTokens,
              outputTokens,
            }) / 2
          : undefined;
    results.push({
      id: item.id,
      status: item.status,
      text: item.text,
      ...(costUsd !== undefined ? { costUsd } : undefined),
      ...(costUsd !== undefined && (!billed || billed.estimated)
        ? { costEstimated: true as const }
        : undefined),
    });
  }
  return results;
}

/** Batch operations share the Gateway credential path on each request. */
export const gatewayObservationBatch = {
  status: observationBatchStatus,
  results: observationBatchResults,
  submit: submitObservationBatch,
};
