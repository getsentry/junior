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

function hashJson(value: unknown): string {
  return digest(
    createHash("sha256").update(JSON.stringify(value, withoutCacheControl)),
  );
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
function messagesAttributes(
  messages: readonly unknown[],
): Record<string, string | number> {
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
  return {
    "app.ai.request.messages.count": messages.length,
    "app.ai.request.messages.hash": digest(hash),
    ...(beforeLastReply
      ? { "app.ai.request.messages.before_last_reply.hash": beforeLastReply }
      : undefined),
  };
}

function payloadAttributes(
  payload: Record<string, unknown>,
): Record<string, string | number> {
  const { system, tools, messages } = payload;
  return {
    ...(system !== undefined
      ? { "app.ai.request.system_instructions.hash": hashJson(system) }
      : undefined),
    "app.ai.request.tools.count": Array.isArray(tools) ? tools.length : 0,
    ...(Array.isArray(tools)
      ? { "app.ai.request.tools.hash": hashJson(tools) }
      : undefined),
    ...(Array.isArray(messages) ? messagesAttributes(messages) : undefined),
  };
}

/**
 * Hashes of the system prompt, tool list, and messages in one provider
 * request body, to tell a changed cache prefix apart from an expired cache.
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
