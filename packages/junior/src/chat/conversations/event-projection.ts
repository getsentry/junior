/**
 * Provider-neutral projection of Junior conversation events.
 *
 * This reducer preserves opaque model messages while aligning their durable
 * provenance and event sequence. Provider adapters validate the opaque payload
 * only when they turn this projection into provider-specific state.
 */
import type { ModelProfile } from "@/chat/model-profile";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "./provenance";
import type {
  ConversationEvent,
  ConversationEventData,
  ConversationModelMessage,
} from "./history";

type MessageEventData = Extract<ConversationEventData, { type: "message" }>;
type AuthorizationCompletedEventData = Extract<
  ConversationEventData,
  { type: "authorization_completed" }
>;

/** Opaque model context projected from ordered Junior conversation events. */
export interface ConversationEventProjection {
  messages: ConversationModelMessage[];
  provenance: ConversationMessageProvenance[];
  seqs: number[];
  modelProfile: ModelProfile;
  modelId: string | undefined;
}

function authorizationObservationMessage(
  data: AuthorizationCompletedEventData,
  createdAtMs: number,
): ConversationModelMessage {
  const label = data.kind === "mcp" ? "MCP authorization" : "Authorization";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${label} completed for provider "${data.provider}". Continue the blocked request and retry the provider operation if needed.`,
      },
    ],
    timestamp: createdAtMs,
  } as ConversationModelMessage;
}

function messageEventProvenance(
  data: MessageEventData,
): ConversationMessageProvenance {
  return data.provenance ?? contextProvenance;
}

/**
 * Project ordered Junior events into provider-neutral model context.
 *
 * Host-only events are filtered, completed authorization becomes a synthetic
 * observation, and `maxSeq` reproduces an exact committed boundary.
 */
export function projectConversationEventHistory(
  events: ConversationEvent[],
  options?: { maxSeq?: number },
): ConversationEventProjection {
  const messages: ConversationModelMessage[] = [];
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
      messages.push(event.data.message);
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
