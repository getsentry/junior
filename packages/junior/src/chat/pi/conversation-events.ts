/**
 * Pi adapter for Junior conversation events.
 *
 * Conversation storage owns the canonical ordered event log and its generic
 * projection. This module validates the opaque projected messages as Pi state.
 */
import type { ModelProfile } from "@/chat/model-profile";
import type { ConversationEvent } from "@/chat/conversations/history";
import { projectConversationEventHistory } from "@/chat/conversations/event-projection";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";

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
  const projection = projectConversationEventHistory(events, options);
  return {
    ...projection,
    messages: projection.messages.map((message) =>
      piMessageSchema.parse(message),
    ),
  };
}
