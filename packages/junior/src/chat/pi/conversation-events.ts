/**
 * Pi adapter for Junior conversation events.
 *
 * Conversation storage owns the canonical ordered event log. This module is
 * the sole boundary that interprets its opaque messages as Pi state.
 */
import type { ModelProfile } from "@/chat/model-profile";
import { extractGenAiUsageSummary } from "@/chat/logging";
import type {
  ConversationEvent,
  ConversationEventData,
} from "@/chat/conversations/history";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";

type MessageEventData = Extract<ConversationEventData, { type: "message" }>;
type AuthorizationCompletedEventData = Extract<
  ConversationEventData,
  { type: "authorization_completed" }
>;

/** Pi context projected from one Junior conversation epoch. */
export interface PiConversationProjection {
  messages: PiMessage[];
  provenance: ConversationMessageProvenance[];
  modelProfile: ModelProfile;
  modelId: string | undefined;
}

/** Pi context with the source event sequence for every projected message. */
export interface PiConversationEventProjection extends PiConversationProjection {
  seqs: number[];
}

/** Usage attributed to one provider/model pair across canonical history. */
export interface ConversationModelUsage {
  modelId: string;
  usage: AgentTurnUsage;
}

function authorizationObservationMessage(
  data: AuthorizationCompletedEventData,
  createdAtMs: number,
): PiMessage {
  const label = data.kind === "mcp" ? "MCP authorization" : "Authorization";
  return piMessageSchema.parse({
    role: "user",
    content: [
      {
        type: "text",
        text: `${label} completed for provider "${data.provider}". Continue the blocked request and retry the provider operation if needed.`,
      },
    ],
    timestamp: createdAtMs,
  });
}

function messageEventProvenance(
  data: MessageEventData,
): ConversationMessageProvenance {
  return data.provenance ?? contextProvenance;
}

/**
 * Project ordered Junior events into Pi context.
 *
 * Host-only events are filtered, completed authorization becomes a synthetic
 * observation, and `maxSeq` reproduces an exact committed boundary.
 */
export function projectConversationEvents(
  events: ConversationEvent[],
  options?: { maxSeq?: number },
): PiConversationEventProjection {
  const messages: PiMessage[] = [];
  const provenance: ConversationMessageProvenance[] = [];
  const seqs: number[] = [];
  let modelProfile: ModelProfile = "standard";
  let modelId: string | undefined;

  for (const event of events) {
    if (options?.maxSeq !== undefined && event.seq > options.maxSeq) break;
    if (event.data.type === "context_epoch_started") {
      modelProfile = event.data.modelProfile ?? "standard";
      modelId = event.data.modelId;
      continue;
    }
    if (event.data.type === "message") {
      messages.push(piMessageSchema.parse(event.data.message));
      provenance.push(messageEventProvenance(event.data));
      seqs.push(event.seq);
      continue;
    }
    if (event.data.type === "authorization_completed") {
      messages.push(
        authorizationObservationMessage(event.data, event.createdAtMs),
      );
      provenance.push(contextProvenance);
      seqs.push(event.seq);
    }
  }

  return { messages, provenance, seqs, modelProfile, modelId };
}

/**
 * Aggregate model usage without recounting messages copied into later epochs.
 *
 * Occurrence counts preserve legitimate identical messages within one epoch,
 * while exact copies introduced by compaction or rollback contribute once.
 */
export function projectConversationModelUsage(
  events: ConversationEvent[],
): ConversationModelUsage[] {
  const messagesByEpoch = new Map<number, PiMessage[]>();
  for (const event of events) {
    if (event.data.type !== "message") continue;
    const messages = messagesByEpoch.get(event.contextEpoch) ?? [];
    messages.push(piMessageSchema.parse(event.data.message));
    messagesByEpoch.set(event.contextEpoch, messages);
  }

  const maxOccurrencesByMessage = new Map<string, number>();
  const usageByModel = new Map<string, AgentTurnUsage>();
  for (const messages of messagesByEpoch.values()) {
    const epochOccurrences = new Map<string, number>();
    for (const message of messages) {
      // SQL jsonb normalizes persisted objects, so exact copied messages have
      // one stable representation without a quadratic deep-equality scan.
      const fingerprint = JSON.stringify(message);
      const ordinal = (epochOccurrences.get(fingerprint) ?? 0) + 1;
      epochOccurrences.set(fingerprint, ordinal);
      if (
        ordinal <= (maxOccurrencesByMessage.get(fingerprint) ?? 0) ||
        !isAssistantMessage(message)
      ) {
        continue;
      }
      const usage = extractGenAiUsageSummary(message);
      if (!hasAgentTurnUsage(usage)) continue;
      const modelId = `${message.provider}/${message.model}`;
      const cumulative = addAgentTurnUsage(usageByModel.get(modelId), usage);
      if (cumulative) usageByModel.set(modelId, cumulative);
    }
    for (const [fingerprint, count] of epochOccurrences) {
      maxOccurrencesByMessage.set(
        fingerprint,
        Math.max(maxOccurrencesByMessage.get(fingerprint) ?? 0, count),
      );
    }
  }

  return [...usageByModel.entries()]
    .map(([modelId, usage]) => ({ modelId, usage }))
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}
