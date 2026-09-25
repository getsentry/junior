import { z } from "zod";

const messageTypes = new Set([
  "user_message",
  "assistant_message",
  "tool_result",
]);
const encodedMessageSchema = z.object({
  message: z.string(),
  provenance: z.unknown().optional(),
});
const messageFieldsSchema = z.record(z.string(), z.unknown());
const replacementEntrySchema = z.object({
  item: z.object({ type: z.string() }).passthrough(),
  sourceEventSeq: z.number().optional(),
});

function encodeMessage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { provenance, ...message } = payload;
  const encoded: Record<string, unknown> = {
    message: JSON.stringify(message),
    // Derived SQL reporting fields are never used to restore model history.
    model: message.model,
    provider: message.provider,
    usage: message.usage,
    toolCallId: message.toolCallId,
  };
  if (provenance !== undefined) encoded.provenance = provenance;
  return encoded;
}

function decodeMessage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { message, provenance } = encodedMessageSchema.parse(payload);
  const decoded = messageFieldsSchema.parse(JSON.parse(message));
  if (provenance !== undefined) decoded.provenance = provenance;
  return decoded;
}

function mapMessages(
  type: string,
  payload: Record<string, unknown>,
  convert: typeof encodeMessage,
): Record<string, unknown> {
  if (messageTypes.has(type)) return convert(payload);
  if (type === "handoff" || type === "compaction") {
    const entries = z
      .array(replacementEntrySchema)
      .parse(payload.replacementHistory);
    return {
      ...payload,
      replacementHistory: entries.map(({ item, ...entry }) => {
        const { type: itemType, ...fields } = item;
        if (!messageTypes.has(itemType))
          throw new Error(`Unsupported history item "${itemType}"`);
        return { ...entry, item: { ...convert(fields), type: itemType } };
      }),
    };
  }
  throw new Error(`Unsupported encoded history event "${type}"`);
}

/** Identify event types that use the lossless version-two message encoding. */
export function isEncodedHistoryType(type: string): boolean {
  return messageTypes.has(type) || type === "handoff" || type === "compaction";
}

/** Encode model history once, before JSONB can alter keys or string content. */
export function encodeHistoryPayload(
  type: string,
  payload: Record<string, unknown>,
): {
  schemaVersion: number;
  payload: Record<string, unknown>;
} {
  if (!isEncodedHistoryType(type)) {
    return { schemaVersion: 1, payload };
  }
  return {
    schemaVersion: 2,
    payload: mapMessages(type, payload, encodeMessage),
  };
}

/** Restore version-two history without using its derived reporting fields. */
export function decodeHistoryPayload(
  type: string,
  payload: unknown,
): Record<string, unknown> {
  return mapMessages(type, messageFieldsSchema.parse(payload), decodeMessage);
}
