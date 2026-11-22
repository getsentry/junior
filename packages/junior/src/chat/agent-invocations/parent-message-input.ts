import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { credentialContextSchema } from "@/chat/credentials/context";
import type { InboundMessage } from "@/chat/task-execution/store";

/**
 * A parent agent task or message to a child that no Agent invocation names:
 * who sent it and the instruction. It names the parent Conversation, the
 * Actor and grants of the parent's Turn, and the `spawnAgent` or
 * `messageAgent` tool call that sent it. Its text is the raw task. `fork`
 * marks the task of a fork spawn.
 */
const parentMessageSchema = z
  .object({
    actor: actorSchema,
    credentialContext: credentialContextSchema.optional(),
    fork: z.literal(true).optional(),
    kind: z.literal("parent_message"),
    parentConversationId: z.string().min(1),
    parentToolCallId: z.string().min(1),
  })
  .strict();

/** One parent agent task or message read from a child's mailbox. */
export type ParentMessage = z.output<typeof parentMessageSchema>;

/**
 * Read the parent message that one mailbox input is, if it is one. Check its
 * sender with `isFromStoredParent` before it gets any authority.
 */
export function readParentMessage(
  message: InboundMessage,
): ParentMessage | undefined {
  if (message.source !== "internal") {
    return undefined;
  }
  const parsed = parentMessageSchema.safeParse(message.input.metadata);
  return parsed.success ? parsed.data : undefined;
}
