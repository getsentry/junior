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
  AgentHistoryItem,
} from "@/chat/conversations/history";
import { agentHistoryItemSchema } from "@/chat/conversations/history";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import { type ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { contextProvenance } from "@/chat/conversations/provenance";
type AuthorizationCompletedEventData = Extract<
  ConversationEventData,
  { type: "authorization_completed" }
>;

/** Pi context projected from one Junior model-history version. */
export interface PiConversationProjection {
  messages: PiMessage[];
  provenance: ConversationMessageProvenance[];
  modelProfile: ModelProfile;
  historyReplacementType: "compaction" | "handoff" | undefined;
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

function durableMessages(message: PiMessage): PiMessage[] {
  return stripRuntimeTurnContext([message]);
}

/** Translate one Pi message into Junior's native durable history item. */
export function historyItemFromPiMessage(
  message: PiMessage,
  provenance: ConversationMessageProvenance,
): AgentHistoryItem {
  const parsed = piMessageSchema.parse(message) as PiMessage & {
    role: string;
  };
  const { role, ...fields } = parsed;
  if (role === "user") {
    return agentHistoryItemSchema.parse({
      ...fields,
      type: "user_message",
      provenance,
    });
  }
  if (role === "assistant") {
    return agentHistoryItemSchema.parse({
      ...fields,
      type: "assistant_message",
    });
  }
  if (role === "toolResult") {
    return agentHistoryItemSchema.parse({
      ...fields,
      type: "tool_result",
    });
  }
  throw new Error(`Unsupported durable agent message role "${role}"`);
}

/** Translate one Junior-native history item into the Pi message it represents. */
export function piMessageFromHistoryItem(data: AgentHistoryItem): PiMessage {
  if (data.type === "user_message") {
    const { type: _, provenance: __, ...fields } = data;
    return piMessageSchema.parse({ ...fields, role: "user" });
  }
  if (data.type === "assistant_message") {
    const { type: _, ...fields } = data;
    return piMessageSchema.parse({ ...fields, role: "assistant" });
  }
  const { type: _, ...fields } = data;
  return piMessageSchema.parse({ ...fields, role: "toolResult" });
}

function historyItemProvenance(
  data: AgentHistoryItem,
): ConversationMessageProvenance {
  return data.type === "user_message" ? data.provenance : contextProvenance;
}

/**
 * Project ordered Junior events into Pi context.
 *
 * Compaction and handoff start with replacement history. Later native history
 * events append after it.
 *
 * Host-only events are filtered, completed authorization becomes a synthetic
 * observation, and `maxSeq` reproduces an exact committed boundary.
 */
export function projectConversationEvents(
  events: ConversationEvent[],
  options: { defaultProfile: ModelProfile; maxSeq?: number },
): PiConversationEventProjection {
  const messages: PiMessage[] = [];
  const provenance: ConversationMessageProvenance[] = [];
  const seqs: number[] = [];
  let modelProfile: ModelProfile = options.defaultProfile;
  let historyReplacementType: "compaction" | "handoff" | undefined;

  for (const event of events) {
    if (options.maxSeq !== undefined && event.seq > options.maxSeq) break;
    // Skipping an unknown active-history fact could silently change model
    // context; an upgrade migration must normalize it before replay.
    if (event.data.type === "unknown") {
      throw new Error(
        `Unsupported conversation event "${event.data.originalType}" at seq ${event.seq} (schema version ${event.schemaVersion})`,
      );
    }
    if (event.data.type === "compaction" || event.data.type === "handoff") {
      modelProfile = event.data.modelProfile;
      historyReplacementType = event.data.type;
      for (const replacement of event.data.replacementHistory) {
        for (const message of durableMessages(
          piMessageFromHistoryItem(replacement.item),
        )) {
          messages.push(message);
          provenance.push(historyItemProvenance(replacement.item));
          seqs.push(replacement.sourceEventSeq ?? event.seq);
        }
      }
      continue;
    }
    if (
      event.data.type === "user_message" ||
      event.data.type === "assistant_message" ||
      event.data.type === "tool_result"
    ) {
      for (const message of durableMessages(
        piMessageFromHistoryItem(event.data),
      )) {
        messages.push(message);
        provenance.push(historyItemProvenance(event.data));
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

  return {
    messages,
    provenance,
    seqs,
    modelProfile,
    historyReplacementType,
  };
}
