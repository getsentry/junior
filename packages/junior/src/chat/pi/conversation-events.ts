/**
 * Pi adapter for Junior conversation events.
 *
 * Conversation storage owns the ordered event log. This module turns its
 * stored messages into the active Pi context.
 */
import type { ModelProfile } from "@/chat/model-profile";
import type {
  ConversationEvent,
  ConversationEventData,
} from "@/chat/conversations/history";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";

type AgentStepEventData = Extract<
  ConversationEventData,
  { type: "agent_step" }
>;
type AuthorizationCompletedEventData = Extract<
  ConversationEventData,
  { type: "authorization_completed" }
>;

/** Pi context projected from one Junior model-history version. */
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
  data: AgentStepEventData,
): ConversationMessageProvenance {
  return data.provenance ?? contextProvenance;
}

function durableMessages(message: unknown): PiMessage[] {
  return stripRuntimeTurnContext([piMessageSchema.parse(message)]);
}

/**
 * Project ordered Junior events into Pi context.
 *
 * Compaction and handoff start with replacement history. Later agent-step
 * events append after it.
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
    // Skipping an unknown active-history fact could silently change model
    // context; an upgrade migration must normalize it before replay.
    if (event.data.type === "unknown") {
      throw new Error(
        `Unsupported conversation event "${event.data.originalType}" at seq ${event.seq} (schema version ${event.schemaVersion})`,
      );
    }
    if (
      event.data.type === "compaction" ||
      event.data.type === "handoff" ||
      event.data.type === "rollback"
    ) {
      modelProfile = event.data.modelProfile;
      modelId = event.data.modelId;
      for (const replacement of event.data.replacementHistory) {
        for (const message of durableMessages(replacement.message)) {
          messages.push(message);
          provenance.push(replacement.provenance ?? contextProvenance);
          seqs.push(replacement.sourceEventSeq ?? event.seq);
        }
      }
      continue;
    }
    if (event.data.type === "agent_step") {
      for (const message of durableMessages(event.data.message)) {
        messages.push(message);
        provenance.push(messageEventProvenance(event.data));
        seqs.push(event.seq);
      }
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
