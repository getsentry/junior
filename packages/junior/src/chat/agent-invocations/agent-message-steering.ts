import type { Actor } from "@sentry/junior-plugin-api";
import {
  contextProvenance,
  sameActorIdentity,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import type { CredentialContext } from "@/chat/credentials/context";
import { EVENT_MESSAGE_AUTHOR } from "@/chat/events/actor";
import { eventBatchMessageMeta } from "@/chat/events/notification";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import { canSteerForSender } from "@/chat/task-execution/attempt-selection";
import type {
  SteeringInput,
  SteeringSource,
} from "@/chat/task-execution/steering";
import type { InboundMessage } from "@/chat/task-execution/store";
import { childAgentInput } from "./child-input";
import { readChildInputActor } from "./result-actors";
import { readSteeringSender, type SteeringSender } from "./steering-sender";
import {
  isTopLevelAgentMessage,
  readTopLevelMessageSteeringSender,
} from "./top-level-message";

// The sender Turn's steering facts and the provenance that the message
// keeps, or nothing when the input is not an agent message. A message whose
// sender is unknown, or whose sender Turn acts for no person, has no
// steering facts and cannot join.
async function readAgentMessage(message: InboundMessage): Promise<
  | {
      sender: SteeringSender | undefined;
      provenance: ConversationMessageProvenance;
    }
  | undefined
> {
  if (isTopLevelAgentMessage(message)) {
    // Another top-level agent wrote it, so it is data.
    return {
      sender: readTopLevelMessageSteeringSender(message),
      provenance: contextProvenance,
    };
  }
  const input = childAgentInput(message);
  if (input?.kind !== "message") return undefined;
  // A child's message is context with the Actor of the child's Turn.
  const actor = await readChildInputActor(message, input);
  const sender = readSteeringSender(message.input.metadata);
  return {
    sender:
      actor && sender && sameActorIdentity(actor, sender.actor)
        ? sender
        : undefined,
    provenance: actor
      ? { authority: "context", actor }
      : { authority: "context" },
  };
}

/**
 * The steering source of `messageAgent` messages from other agents: a child
 * agent's messages and messages from other top-level agents. Agent updates
 * and results are not messages, so they never join. A message joins only
 * when the Turn that sent it acts for the running Turn's Actor with the same
 * credentials. The first one that cannot join stops the scan, so it and
 * every later one wait for their own Turn in order. A message keeps the
 * rendering and provenance that its own Turn gives it, so it gives no
 * approval.
 */
export function agentMessageSteeringSource(args: {
  actor: Actor;
  credentialContext: CredentialContext;
  /** The Turn's own input, which waits in the mailbox until it commits. */
  turnInputIds: ReadonlySet<string>;
}): SteeringSource {
  const { turnInputIds } = args;
  const turn = { actor: args.actor, credentialContext: args.credentialContext };
  return {
    // Agent messages keep `defer` delivery, so this source scopes them.
    deferred: true,
    select: async (pending) => {
      const inputs: SteeringInput[] = [];
      for (const message of pending) {
        if (turnInputIds.has(message.inboundMessageId)) continue;
        // oxlint-disable-next-line no-await-in-loop -- Stop at the first message that cannot join, so steering keeps message order.
        const agentMessage = await readAgentMessage(message);
        if (!agentMessage) continue;
        const { sender, provenance } = agentMessage;
        if (!sender || !canSteerForSender(turn, sender)) {
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
            provenance,
            text: message.input.text.trim(),
            timestampMs: message.createdAtMs,
          },
        });
      }
      return { inputs, readIds: inputs.map((input) => input.message.id) };
    },
  };
}
