import * as z from "zod";
import {
  assertCanReadConversationEvents,
  stripReplacementHistory,
} from "@/chat/conversations/event-access";
import type { ConversationEvent } from "@/chat/conversations/history";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationEventStore } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const readConversationEventOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  history_version: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  type: z.string().min(1).describe("Event type."),
  tool_name: z
    .string()
    .min(1)
    .optional()
    .describe("Tool that produced a tool_result event."),
  is_error: z
    .boolean()
    .optional()
    .describe("Whether a tool_result event was an error."),
  text: z
    .string()
    .describe("Event text from offset, at most limit chars when set."),
  offset: z.number().int().nonnegative(),
  total_chars: z.number().int().nonnegative(),
  has_more: z.boolean().describe("Whether text continues after this slice."),
});

export const readConversationEventToolDefinition = zodToolDefinition({
  description:
    "Read the full text of one conversation event by seq. Set offset or limit to read part of it. Works for events from earlier history versions, such as cleared tool results.",
  exposure: "deferred",
  source: CONVERSATIONS_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  inputSchema: z
    .object({
      seq: z.number().int().nonnegative().describe("Event sequence number."),
      conversation_id: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe("Conversation ID. Omit or null for the current conversation.")
        .optional(),
      offset: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe("First char to return. Default 0.")
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .nullable()
        .describe("Maximum chars. Default: all text after offset.")
        .optional(),
    })
    .strict(),
  outputSchema: readConversationEventOutputSchema,
});

/**
 * Create a deferred tool that reads one full event of a conversation log.
 * The event lives in the database, so the default returns all of its text.
 * The tool pipeline cuts long text for the model and saves the full text to a
 * Sandbox file.
 */
export function createReadConversationEventTool(context: ToolRuntimeContext) {
  return zodTool({
    ...readConversationEventToolDefinition,
    execute: async (input) => {
      const conversationId =
        input.conversation_id?.trim() || context.conversationId;
      const offset = input.offset ?? 0;
      const limit = input.limit ?? undefined;

      await assertCanReadConversationEvents(context, conversationId);
      // The log query has no history-version filter, so this finds events
      // that a compaction replaced.
      const page = await getConversationEventStore().query(conversationId, {
        afterSeq: input.seq - 1,
        beforeSeq: input.seq + 1,
        limit: 1,
      });
      const event = page.events[0];
      if (!event) {
        throw new ToolInputError(
          `Conversation event not found: seq ${input.seq} in ${conversationId}`,
        );
      }

      const text = eventText(event.data);
      if (offset > 0 && offset >= text.length) {
        throw new ToolInputError(
          `offset ${offset} is past the end of the event text (${text.length} chars)`,
        );
      }
      const slice = text.slice(
        offset,
        limit === undefined ? undefined : offset + limit,
      );
      return {
        conversation_id: conversationId,
        seq: event.seq,
        history_version: event.historyVersion,
        created_at: new Date(event.createdAtMs).toISOString(),
        type:
          event.data.type === "unknown"
            ? event.data.originalType
            : event.data.type,
        ...toolResultFields(event.data),
        text: slice,
        offset,
        total_chars: text.length,
        has_more: offset + slice.length < text.length,
      };
    },
  });
}

function toolResultFields(data: ConversationEvent["data"]) {
  if (data.type !== "tool_result") return undefined;
  return {
    ...(typeof data["toolName"] === "string" && data["toolName"]
      ? { tool_name: data["toolName"] }
      : undefined),
    ...(typeof data["isError"] === "boolean"
      ? { is_error: data["isError"] }
      : undefined),
  };
}

/**
 * Render agent history items as the text the model saw, and messages as their
 * text. Other events render as JSON without replacement history, which stays
 * readable through its original events.
 */
function eventText(data: ConversationEvent["data"]): string {
  switch (data.type) {
    case "user_message":
    case "assistant_message":
    case "tool_result":
      return contentText(data["content"]);
    case "message":
    case "message_updated":
      return data.text;
    default:
      return JSON.stringify(stripReplacementHistory(data), null, 2);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(contentPartText).join("\n");
}

function contentPartText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  switch (value["type"]) {
    case "text":
      return typeof value["text"] === "string" ? value["text"] : "";
    case "image":
      return `[image: ${typeof value["mimeType"] === "string" ? value["mimeType"] : "unknown type"}]`;
    case "toolCall":
      return `[tool call: ${String(value["name"])} ${JSON.stringify(value["arguments"] ?? {})}]`;
    default:
      // Thinking blocks and unknown parts are not returned.
      return "";
  }
}
