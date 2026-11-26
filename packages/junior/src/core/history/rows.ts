// How agent history items and History replacements are stored in event rows.
// Schema version 2 keeps each message as a JSON string, so Postgres JSON
// cannot change its keys or string contents. Version 1 rows, from before,
// store the fields as they are.
import {
  AGENT_HISTORY_ITEM_TYPES,
  type AgentHistoryItem,
  agentHistoryItemSchema,
  HISTORY_REPLACEMENT_TYPES,
  historyReplacementDataSchema,
  type HistoryReplacementData,
  isHistoryReplacement,
  isHistoryReplacementType,
} from "./items";
import * as z from "zod";
import type { juniorConversationEvents } from "@/db/schema";

type EventRow = typeof juniorConversationEvents.$inferSelect;

/** The event type of core's data: an agent history item or a replacement. */
export type AgentHistoryType = (
  | AgentHistoryItem
  | HistoryReplacementData
)["type"];

const messageFieldsSchema = z.record(z.string(), z.unknown());
const replacementEntrySchema = z.object({ item: z.string() }).passthrough();
const agentHistoryTypes: ReadonlySet<string> = new Set([
  ...AGENT_HISTORY_ITEM_TYPES,
  ...HISTORY_REPLACEMENT_TYPES,
]);

/** True when an event type is core's. Every other type is the host's. */
export function isAgentHistoryType(type: string): type is AgentHistoryType {
  return agentHistoryTypes.has(type);
}

/** True when event data is core's. Every other event data is the host's. */
export function isAgentHistoryData<T extends { type: string }>(
  data: T,
): data is Extract<T, { type: AgentHistoryType }> {
  return isAgentHistoryType(data.type);
}

/** Encode core's event data as a version 2 row payload. */
export function encodeAgentHistoryPayload(
  data: AgentHistoryItem | HistoryReplacementData,
): { schemaVersion: 2; payload: Record<string, unknown> } {
  if (isHistoryReplacement(data)) {
    const { type: _, ...payload } = data;
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
  const { type: _, ...fields } = data;
  const { provenance, ...message }: Record<string, unknown> = fields;
  return {
    schemaVersion: 2,
    payload: {
      message: JSON.stringify(message),
      provenance,
      // SQL reports read these fields. Replay reads only the message string.
      model: message["model"],
      provider: message["provider"],
      usage: message["usage"],
      toolCallId: message["toolCallId"],
      stopReason: message["stopReason"],
      timestamp: message["timestamp"],
      toolName: message["toolName"],
      isError: message["isError"],
    },
  };
}

/** Decode a version 2 payload of core's type into its fields, without `type`. */
export function decodeAgentHistoryPayload(
  type: AgentHistoryType,
  payload: unknown,
): Record<string, unknown> {
  const fields = messageFieldsSchema.parse(payload);
  if (isHistoryReplacementType(type)) {
    return {
      ...fields,
      replacementHistory: z
        .array(replacementEntrySchema)
        .parse(fields["replacementHistory"])
        .map(({ item, ...entry }) => {
          const parsedItem: unknown = JSON.parse(item);
          return { ...entry, item: parsedItem };
        }),
    };
  }
  const message = messageFieldsSchema.parse(
    JSON.parse(z.string().parse(fields["message"])),
  );
  if (fields["provenance"] !== undefined)
    message["provenance"] = fields["provenance"];
  return message;
}

/** Decode one stored row of core's type. Throws on any other row. */
export function agentHistoryFromRow(
  row: Pick<EventRow, "type" | "schemaVersion" | "payload">,
): AgentHistoryItem | HistoryReplacementData {
  const { type } = row;
  if (!isAgentHistoryType(type)) {
    throw new Error(`Event type ${type} is not agent history`);
  }
  const fields =
    row.schemaVersion === 2
      ? decodeAgentHistoryPayload(type, row.payload)
      : row.schemaVersion === 1
        ? messageFieldsSchema.parse(row.payload)
        : undefined;
  if (fields === undefined) {
    throw new Error(
      `Agent history row has unknown schema version ${row.schemaVersion}`,
    );
  }
  const data = { ...fields, type };
  return isHistoryReplacementType(type)
    ? historyReplacementDataSchema.parse(data)
    : agentHistoryItemSchema.parse(data);
}
