import { pluginToolReplySchema } from "@sentry/junior-plugin-api";
import { isRecord } from "@/chat/coerce";
import { getConversationEventStore } from "@/chat/db";

/**
 * Record the reply that a plugin tool posted for Junior, such as a pull
 * request comment, and remove it from the model-facing result. The model
 * wrote the text, so it reads only the provider facts.
 */
export async function recordToolReply(args: {
  conversationId: string;
  plugin: string;
  result: unknown;
  toolCallId?: string;
}): Promise<unknown> {
  const { result } = args;
  if (!isRecord(result) || result["isError"] === true) return result;
  const details = isRecord(result["details"]) ? result["details"] : result;
  if (details["reply"] === undefined) return result;
  const reply = pluginToolReplySchema.parse(details["reply"]);
  if (args.toolCallId) {
    await getConversationEventStore().append(args.conversationId, [
      {
        // A retried tool call must not show the reply twice.
        idempotencyKey: `reply_posted:tool:${args.toolCallId}`,
        data: {
          type: "reply_posted",
          plugin: args.plugin,
          text: reply.text,
          ...(reply.url ? { url: reply.url } : undefined),
          toolCallId: args.toolCallId,
        },
        createdAtMs: Date.now(),
      },
    ]);
  }
  const { reply: _reply, ...rest } = details;
  if (isRecord(result["details"])) return { ...result, details: rest };
  return rest;
}
