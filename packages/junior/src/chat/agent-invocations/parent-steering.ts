import type { Actor } from "@sentry/junior-plugin-api";
import { mapBounded } from "@/chat/fan-out";
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import type { CredentialContext } from "@/chat/credentials/context";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import type { ConversationAuthor } from "@/chat/state/conversation";
import { canSteerParentTurn } from "@/chat/task-execution/attempt-selection";
import type { SteeringSource } from "@/chat/task-execution/steering";
import type { InboundMessage } from "@/chat/task-execution/store";
import { isDroppedChildInput } from "./child-input";
import { logDroppedParentMessage, parentMessageText } from "./parent-message";
import { readParentMessage, type ParentMessage } from "./parent-message-input";

/**
 * The steering source of a Turn that its parent started: the parent's later
 * messages. A message joins only when it comes from the stored parent with
 * the Turn's author, Actor, and credentials. The first one that cannot join
 * stops the scan, so it and every later message wait for their own Turn in
 * order. A message that the sender check drops is read and gets no
 * authority.
 */
export function parentSteeringSource(args: {
  actor: Actor;
  /** Transcript author of the Turn's parent messages. */
  author: ConversationAuthor;
  credentialContext: CredentialContext;
  /** The Turn's own input, which waits in the mailbox until it commits. */
  turnInputIds: ReadonlySet<string>;
}): SteeringSource {
  const { author, turnInputIds } = args;
  const turn = {
    actor: args.actor,
    authorId: author.userId,
    credentialContext: args.credentialContext,
  };
  return {
    // Parent messages keep `defer` delivery, so this source scopes them.
    deferred: true,
    select: async (pending) => {
      const readIds: string[] = [];
      const joining: { message: InboundMessage; parent: ParentMessage }[] = [];
      for (const message of pending) {
        const parent = readParentMessage(message);
        if (!parent || turnInputIds.has(message.inboundMessageId)) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- Stop at the first message that cannot join, so steering keeps message order.
        if (await isDroppedChildInput(message)) {
          logDroppedParentMessage(message, parent);
          readIds.push(message.inboundMessageId);
          continue;
        }
        if (!canSteerParentTurn(turn, message)) {
          break;
        }
        joining.push({ message, parent });
        readIds.push(message.inboundMessageId);
      }
      const inputs = await mapBounded(joining, async ({ message, parent }) => {
        const text = await parentMessageText(message, parent);
        const requestText = message.input.text.trim();
        return {
          message: {
            id: message.inboundMessageId,
            role: "user" as const,
            text: normalizeConversationText(text),
            createdAtMs: message.createdAtMs,
            author,
            authorIdentityId: message.input.authorIdentityId,
            meta: {
              explicitMention: true,
              ...(requestText ? { requestText } : undefined),
            },
          },
          steering: {
            kind: "runtime" as const,
            provenance: agentInstructionProvenance,
            text,
            timestampMs: message.createdAtMs,
          },
        };
      });
      return { inputs, readIds };
    },
  };
}
