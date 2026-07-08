import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { parseSlackThreadId } from "@/chat/slack/context";

export type ConversationPrivacy = "public" | "private";
type TraceAttributeValue = string | number | boolean | string[];
const SAFE_METADATA_KEY_LIMIT = 20;
const conversationPrivacyStorage = new AsyncLocalStorage<ConversationPrivacy>();

function privateNarrowingFromChannelId(
  channelId: string | undefined,
): ConversationPrivacy | undefined {
  const normalized = channelId?.trim();
  if (!normalized) return undefined;
  // Channel-id prefixes may only narrow toward private. `C`-prefixed ids do
  // not prove a conversation public: modern Slack private channels also use
  // `C` prefixes, so they stay unknown without a confirmed signal.
  return normalized.startsWith("D") || normalized.startsWith("G")
    ? "private"
    : undefined;
}

function privateNarrowingFromConversationId(
  conversationId: string | undefined,
): ConversationPrivacy | undefined {
  const normalized = conversationId?.trim();
  if (!normalized) return undefined;
  const slackThread = parseSlackThreadId(normalized);
  if (slackThread) {
    return privateNarrowingFromChannelId(slackThread.channelId);
  }
  if (normalized.startsWith("slack:")) {
    return undefined;
  }
  // Non-Slack conversations (local CLI, internal runs) are private surfaces.
  return "private";
}

/**
 * Resolve whether a conversation may expose raw payloads.
 *
 * Only a live source signal or persisted destination visibility can classify
 * a conversation public. Identifier prefixes may only narrow classification
 * toward private. Unknown stays undefined so callers fail closed to private.
 */
export function resolveConversationPrivacy(input: {
  channelId?: string;
  conversationId?: string;
  /** Live source or persisted visibility, when the caller has one. */
  visibility?: ConversationPrivacy;
}): ConversationPrivacy | undefined {
  const narrowed =
    privateNarrowingFromChannelId(input.channelId) ??
    privateNarrowingFromConversationId(input.conversationId);
  if (narrowed === "private") {
    return "private";
  }
  return input.visibility;
}

/** Gate raw transcript/tool payload exposure to public conversations. */
export function canExposeConversationPayload(input: {
  channelId?: string;
  conversationId?: string;
  /** Live source or persisted visibility, when the caller has one. */
  visibility?: ConversationPrivacy;
}): boolean {
  return resolveConversationPrivacy(input) === "public";
}

/** Return the privacy mode bound to the current agent turn. */
export function getCurrentConversationPrivacy():
  | ConversationPrivacy
  | undefined {
  return conversationPrivacyStorage.getStore();
}

/** Bind one conversation privacy mode to all async work in a turn. */
export function runWithConversationPrivacy<T>(
  privacy: ConversationPrivacy,
  callback: () => T,
): T {
  return conversationPrivacyStorage.run(privacy, callback);
}

function contentMetadata(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "text", chars: content.length }];
  }
  if (!Array.isArray(content)) {
    return { type: typeof content };
  }
  return content.map((part) => {
    if (!part || typeof part !== "object") {
      return { type: typeof part };
    }
    const record = part as Record<string, unknown>;
    const type = canonicalContentPartType(
      typeof record.type === "string" ? record.type : "unknown",
    );
    return {
      type,
      ...(typeof record.text === "string"
        ? { chars: record.text.length }
        : typeof record.thinking === "string" && record.thinking.length > 0
          ? { chars: record.thinking.length }
          : {}),
      ...(typeof record.mimeType === "string"
        ? { mimeType: record.mimeType }
        : {}),
      ...(typeof record.mediaType === "string"
        ? { mediaType: record.mediaType }
        : {}),
      ...(typeof record.data === "string"
        ? { dataChars: record.data.length }
        : {}),
    };
  });
}

/** Convert a GenAI message into safe metadata for private trace contexts. */
export function toGenAiMessageMetadata(
  message: unknown,
): Record<string, unknown> {
  const record =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  return {
    role: record.role,
    content: contentMetadata(record.content),
  };
}

/** Convert raw text into size-only metadata for private trace contexts. */
export function toGenAiTextMetadata(text: string): Record<string, unknown> {
  return { type: "text", chars: text.length };
}

function payloadType(payload: unknown): string {
  return Array.isArray(payload) ? "array" : typeof payload;
}

function payloadKeys(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const keys = Object.keys(payload as Record<string, unknown>).slice(
    0,
    SAFE_METADATA_KEY_LIMIT,
  );
  return keys.length > 0 ? keys : undefined;
}

function serializedLength(payload: unknown): number {
  const serialized =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return serialized?.length ?? 0;
}

/** Convert an arbitrary payload into safe structured metadata for trace data fields. */
export function toGenAiPayloadMetadata(
  payload: unknown,
): Record<string, unknown> {
  const base = {
    type: payloadType(payload),
    chars: serializedLength(payload),
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return base;
  }
  const keys = payloadKeys(payload);
  return {
    ...base,
    ...(keys ? { keys } : {}),
  };
}

/** Convert an arbitrary payload into safe flattened trace attributes. */
export function toGenAiPayloadTraceAttributes(
  prefix: string,
  payload: unknown,
): Record<string, TraceAttributeValue> {
  const attributes: Record<string, TraceAttributeValue> = {
    [`${prefix}.type`]: payloadType(payload),
    [`${prefix}.size_chars`]: serializedLength(payload),
  };
  const keys = payloadKeys(payload);
  if (keys) {
    attributes[`${prefix}.keys`] = keys;
  }
  return attributes;
}

function summarizeContent(content: unknown): {
  chars: number;
  partTypes: string[];
} {
  if (typeof content === "string") {
    return { chars: content.length, partTypes: ["text"] };
  }
  if (!Array.isArray(content)) {
    return {
      chars: serializedLength(content),
      partTypes: [payloadType(content)],
    };
  }

  let chars = 0;
  const partTypes = new Set<string>();
  for (const part of content) {
    if (!part || typeof part !== "object") {
      chars += serializedLength(part);
      partTypes.add(payloadType(part));
      continue;
    }
    const record = part as Record<string, unknown>;
    const type = canonicalContentPartType(
      typeof record.type === "string" ? record.type : "unknown",
    );
    partTypes.add(type);
    if (typeof record.text === "string") {
      chars += record.text.length;
    } else if (typeof record.thinking === "string") {
      chars += record.thinking.length;
    } else if (typeof record.data === "string") {
      chars += record.data.length;
    } else {
      chars += serializedLength(part);
    }
  }
  return { chars, partTypes: [...partTypes] };
}

// ---------------------------------------------------------------------------
// Canonical gen_ai attribute format mappers
// ---------------------------------------------------------------------------

function normalizeFinishReason(reason: string): string {
  return reason === "toolUse" ? "tool_use" : reason;
}

function canonicalContentPartType(type: string): string {
  if (type === "thinking") return "reasoning";
  if (type === "toolCall") return "tool_call";
  return type;
}

function toCanonicalPart(
  part: TextContent | ThinkingContent | ImageContent | ToolCall,
): Record<string, unknown> {
  if (part.type === "text") {
    return { type: "text", content: part.text };
  }
  if (part.type === "thinking") {
    if (part.redacted) {
      return { type: "reasoning", redacted: true };
    }
    return { type: "reasoning", content: part.thinking };
  }
  if (part.type === "toolCall") {
    return {
      type: "tool_call",
      id: part.id,
      name: part.name,
      arguments: part.arguments,
    };
  }
  // image — omit raw base64 data, keep type and mimeType only
  return { type: "image", mimeType: (part as ImageContent).mimeType };
}

/**
 * Map a pi-ai AssistantMessage to the canonical gen_ai.output.messages shape:
 * `{ role, parts: [...], finish_reason }` — drops provider noise fields.
 */
export function toCanonicalOutputMessage(
  message: AssistantMessage,
): Record<string, unknown> {
  return {
    role: "assistant",
    parts: message.content.map(toCanonicalPart),
    finish_reason: normalizeFinishReason(message.stopReason),
  };
}

/**
 * Map a pi-ai Message (user/assistant/toolResult) to the canonical
 * gen_ai.input.messages shape: `{ role, parts: [...] }`.
 */
export function toCanonicalInputMessage(
  message: Message,
): Record<string, unknown> {
  if (message.role === "user") {
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", content: message.content }]
        : message.content.map(toCanonicalPart);
    return { role: "user", parts };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      id: message.toolCallId,
      name: message.toolName,
      parts: message.content.map(toCanonicalPart),
    };
  }
  // AssistantMessage appearing as a prior turn in input context
  return toCanonicalOutputMessage(message as AssistantMessage);
}

/** Summarize a message list without exposing raw message content. */
export function toGenAiMessagesTraceAttributes(
  prefix: string,
  messages: unknown[],
): Record<string, TraceAttributeValue> {
  let contentChars = 0;
  const roles = new Set<string>();
  const partTypes = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      contentChars += serializedLength(message);
      continue;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role === "string") {
      roles.add(record.role);
    }
    const summary = summarizeContent(record.content);
    contentChars += summary.chars;
    for (const partType of summary.partTypes) {
      partTypes.add(partType);
    }
  }

  return {
    [`${prefix}.message_count`]: messages.length,
    [`${prefix}.content_chars`]: contentChars,
    ...(roles.size > 0 ? { [`${prefix}.roles`]: [...roles] } : {}),
    ...(partTypes.size > 0 ? { [`${prefix}.part_types`]: [...partTypes] } : {}),
  };
}
