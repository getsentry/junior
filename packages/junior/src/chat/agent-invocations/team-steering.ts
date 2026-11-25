import type { Actor } from "@sentry/junior-plugin-api";
import { contextProvenance } from "@/chat/conversations/provenance";
import {
  credentialContextForActor,
  type CredentialContext,
} from "@/chat/credentials/context";
import { EVENT_MESSAGE_AUTHOR } from "@/chat/events/actor";
import { eventBatchMessageMeta } from "@/chat/events/notification";
import { readSpaceLead } from "@/chat/lead/conversation";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import { canSteerForSender } from "@/chat/task-execution/attempt-selection";
import type {
  SteeringInput,
  SteeringSource,
} from "@/chat/task-execution/steering";
import {
  isTopLevelAgentMessage,
  readTeamMessageSender,
} from "./top-level-message";

/**
 * The steering source of the messages that a Space's Lead sends to a root
 * in its Space. A message joins only when the Lead Turn that sent it acts
 * for the running Turn's Actor with the same credentials. The first
 * top-level message that cannot join stops the scan, so it and every later
 * one wait for their own Turn in order. A message keeps its data rendering
 * and context provenance, so it gives no approval.
 */
export function teamSteeringSource(args: {
  actor: Actor;
  credentialContext: CredentialContext;
  spaceId: string;
}): SteeringSource {
  const { spaceId } = args;
  const turn = { actor: args.actor, credentialContext: args.credentialContext };
  return {
    // Top-level messages keep `defer` delivery, so this source scopes them.
    deferred: true,
    select: async (pending) => {
      const candidates = pending.filter(isTopLevelAgentMessage);
      if (candidates.length === 0) return { inputs: [], readIds: [] };
      const leadId = (await readSpaceLead(spaceId))?.conversationId;
      const inputs: SteeringInput[] = [];
      for (const message of candidates) {
        const sender = readTeamMessageSender(message);
        if (
          !sender ||
          sender.senderConversationId !== leadId ||
          !canSteerForSender(turn, {
            actor: sender.actor,
            credentialContext: credentialContextForActor(sender.actor),
          })
        ) {
          break;
        }
        inputs.push({
          message: {
            id: message.inboundMessageId,
            role: "user",
            text: normalizeConversationText(message.input.text),
            createdAtMs: message.createdAtMs,
            author: EVENT_MESSAGE_AUTHOR,
            authorIdentityId: message.input.authorIdentityId,
            meta: {
              explicitMention: true,
              ...eventBatchMessageMeta([message]),
            },
          },
          steering: {
            kind: "runtime",
            provenance: contextProvenance,
            text: message.input.text.trim(),
            timestampMs: message.createdAtMs,
          },
        });
      }
      return { inputs, readIds: inputs.map((input) => input.message.id) };
    },
  };
}
