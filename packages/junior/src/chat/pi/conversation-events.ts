/**
 * Pi adapter for Junior conversation events.
 *
 * Conversation storage owns the canonical ordered event log. This module is
 * the sole boundary that interprets its opaque messages as Pi state.
 */
import type { ModelProfile } from "@/chat/model-profile";
import type {
  ConversationEvent,
  ConversationEventData,
} from "@/chat/conversations/history";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
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
