import type { ConversationEvent } from "@/chat/conversations/history";
import { extractGenAiUsageSummary } from "@/chat/logging";
import { hasAgentTurnUsage } from "@/chat/usage";
import type { ConversationReportEvent } from "../schema/conversation";

type EventModel = ConversationReportEvent["model"];

/** Apply recorded model choices without carrying a previous turn's settings forward. */
export function conversationEventModel(
  data: ConversationEvent["data"],
  current: EventModel,
): EventModel {
  if (data.type === "turn_started") return undefined;
  if (data.type === "turn_routed" || data.type === "handoff") {
    return {
      modelId: data.modelId,
      modelProfile: data.modelProfile,
      ...(data.reasoningLevel
        ? { reasoningLevel: data.reasoningLevel }
        : undefined),
    };
  }
  if (data.type === "assistant_message") {
    const model = text(data.model);
    const provider = text(data.provider);
    if (model) {
      const modelId =
        model.includes("/") || !provider ? model : `${provider}/${model}`;
      // Keep the selected profile settings even when the provider resolves a model alias.
      return { ...current, modelId };
    }
  }
  return current;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Allowlist model-call diagnostics; never expose opaque provider metadata. */
export function conversationEventModelCall(
  data: ConversationEvent["data"],
): ConversationReportEvent["modelCall"] {
  if (data.type !== "assistant_message") return undefined;
  const usage = extractGenAiUsageSummary(data);
  const provider = text(data.provider);
  const api = text(data.api);
  const stopReason = text(data.stopReason);
  return {
    ...(provider ? { provider } : undefined),
    ...(api ? { api } : undefined),
    ...(stopReason ? { stopReason } : undefined),
    ...(hasAgentTurnUsage(usage) ? { usage } : undefined),
  };
}
