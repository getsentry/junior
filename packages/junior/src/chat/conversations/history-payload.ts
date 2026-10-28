import { z } from "zod";
import type { ConversationEventData } from "./history";

const messageFieldsSchema = z.record(z.string(), z.unknown());
const replacementEntrySchema = z.object({ item: z.string() }).passthrough();

/** Identify history events that store message fields as JSON strings. */
export function isEncodedHistoryType(type: string): boolean {
  return (
    type === "user_message" ||
    type === "assistant_message" ||
    type === "tool_result" ||
    type === "handoff" ||
    type === "compaction"
  );
}

/** Encode agent history before SQL can change keys or string contents. */
export function encodeHistoryPayload(data: ConversationEventData): {
  schemaVersion: number;
  payload: Record<string, unknown>;
} {
  const { type, ...payload } = data;
  if (!isEncodedHistoryType(type)) return { schemaVersion: 1, payload };
  if (data.type === "handoff" || data.type === "compaction") {
    return {
      schemaVersion: 2,
      payload: {
        ...payload,
        replacementHistory: data.replacementHistory.map(
          ({ item, ...entry }) => ({
            ...entry,
            item: JSON.stringify(item),
          }),
        ),
      },
    };
  }
  const { provenance, ...message } = payload as Record<string, unknown>;
  return {
    schemaVersion: 2,
    payload: {
      message: JSON.stringify(message),
      provenance,
      // SQL reports read these fields. Replay reads only the message string.
      model: message.model,
      provider: message.provider,
      usage: message.usage,
      toolCallId: message.toolCallId,
    },
  };
}

/** Decode stored history for validation by the conversation event schema. */
export function decodeHistoryPayload(
  type: string,
  payload: unknown,
): Record<string, unknown> {
  const fields = messageFieldsSchema.parse(payload);
  if (type === "handoff" || type === "compaction") {
    return {
      ...fields,
      replacementHistory: z
        .array(replacementEntrySchema)
        .parse(fields.replacementHistory)
        .map(({ item, ...entry }) => ({ ...entry, item: JSON.parse(item) })),
    };
  }
  const message = messageFieldsSchema.parse(
    JSON.parse(z.string().parse(fields.message)),
  );
  if (fields.provenance !== undefined) message.provenance = fields.provenance;
  return message;
}
