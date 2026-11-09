import { createHash, type Hash } from "node:crypto";

// The provider caches a request prefix in the order tools, system prompt,
// messages. These hashes show on a `gen_ai.chat` span whether that prefix
// changed between two calls, without the prompt or tool text. They hash the
// provider request body that Pi built for AI Gateway, not the request that
// the gateway sends upstream.

const HASH_HEX_CHARS = 16;
// Ends each message in the messages hash, so a prefix of N messages hashes
// the same as a request with only those N messages.
const MESSAGE_SEPARATOR = "\n";

// Pi moves the last cache breakpoint on every request. Leave `cache_control`
// out so the hashes show only content changes.
function withoutCacheControl(key: string, value: unknown): unknown {
  return key === "cache_control" ? undefined : value;
}

// Pi also turns string `content` of the last user message into one text
// block, to add the breakpoint. Hash string content in that block form, so a
// message hashes the same when it is no longer last.
function canonicalMessageValue(key: string, value: unknown): unknown {
  if (key === "content" && typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return withoutCacheControl(key, value);
}

function digest(hash: Hash): string {
  return hash.digest("hex").slice(0, HASH_HEX_CHARS);
}

function hashJson(
  value: unknown,
  replacer: (key: string, value: unknown) => unknown = withoutCacheControl,
): string {
  return digest(createHash("sha256").update(JSON.stringify(value, replacer)));
}

function lastAssistantIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      return index;
    }
  }
  return -1;
}

// One pass over the messages. The hash before the last assistant message
// equals the previous request's full hash when the history was only appended.
function messagesHashes(messages: readonly unknown[]): {
  full: string;
  beforeLastReply?: string;
} {
  const lastReply = lastAssistantIndex(messages);
  const hash = createHash("sha256");
  let beforeLastReply: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (index === lastReply) {
      beforeLastReply = digest(hash.copy());
    }
    hash
      .update(JSON.stringify(message, canonicalMessageValue))
      .update(MESSAGE_SEPARATOR);
  }
  return { full: digest(hash), beforeLastReply };
}

// Sorts object keys, so the settings hash does not depend on key order.
function sortedKeys(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// Hashes the short part hashes in a fixed order. The prefix covers the model,
// the settings that change the cache, and the cached parts of the request.
function prefixHash(parts: ReadonlyArray<string | undefined>): string {
  return digest(
    createHash("sha256").update(parts.map((part) => part ?? "").join("\n")),
  );
}

function readableString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function payloadAttributes(
  payload: Record<string, unknown>,
): Record<string, string | number> {
  const { model, system, tools, messages, thinking, output_config } = payload;
  const systemHash = system !== undefined ? hashJson(system) : undefined;
  const toolsHash = Array.isArray(tools) ? hashJson(tools) : undefined;
  const messagesHash = Array.isArray(messages)
    ? messagesHashes(messages)
    : undefined;
  // Anthropic drops the cached prefix when thinking or effort changes.
  const settingsHash = hashJson({ thinking, output_config }, sortedKeys);
  const prefixParts = [
    typeof model === "string" ? model : undefined,
    settingsHash,
    toolsHash,
    systemHash,
  ];
  const thinkingType = readableString(thinking, "type");
  const effort = readableString(output_config, "effort");
  return {
    ...(systemHash
      ? { "app.ai.request.system_instructions.hash": systemHash }
      : undefined),
    "app.ai.request.tools.count": Array.isArray(tools) ? tools.length : 0,
    ...(toolsHash ? { "app.ai.request.tools.hash": toolsHash } : undefined),
    ...(Array.isArray(messages)
      ? { "app.ai.request.messages.count": messages.length }
      : undefined),
    ...(messagesHash
      ? { "app.ai.request.messages.hash": messagesHash.full }
      : undefined),
    ...(messagesHash?.beforeLastReply
      ? {
          "app.ai.request.messages.before_last_reply.hash":
            messagesHash.beforeLastReply,
        }
      : undefined),
    "app.ai.request.prefix.hash": prefixHash([
      ...prefixParts,
      messagesHash?.full,
    ]),
    ...(messagesHash?.beforeLastReply
      ? {
          "app.ai.request.prefix.before_last_reply.hash": prefixHash([
            ...prefixParts,
            messagesHash.beforeLastReply,
          ]),
        }
      : undefined),
    ...(thinkingType
      ? { "app.ai.request.thinking.type": thinkingType }
      : undefined),
    ...(effort ? { "app.ai.request.effort": effort } : undefined),
  };
}

/**
 * Hashes of the cache prefix parts of one provider request body, plus its
 * thinking and effort settings, to tell a changed cache prefix apart from an
 * expired cache.
 * Pass the payload that Pi gives to `onPayload`. Never throws: telemetry must
 * not fail the request.
 */
export function requestPrefixAttributes(
  payload: unknown,
): Record<string, string | number> {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  try {
    return payloadAttributes(payload as Record<string, unknown>);
  } catch {
    return {};
  }
}
