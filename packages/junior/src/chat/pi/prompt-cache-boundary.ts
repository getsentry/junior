import type { Model } from "@earendil-works/pi-ai";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const RUNTIME_CONTEXT_START = `<${TURN_CONTEXT_TAG}>`;
const CACHEABLE_CONTENT_TYPES = new Set(["text", "image", "tool_result"]);

type PayloadRecord = Record<string, unknown>;

function record(value: unknown): PayloadRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as PayloadRecord)
    : undefined;
}

function contentBlocks(message: PayloadRecord): PayloadRecord[] {
  return Array.isArray(message.content)
    ? message.content.flatMap((part) => {
        const block = record(part);
        return block ? [block] : [];
      })
    : [];
}

function containsRuntimeContext(message: PayloadRecord): boolean {
  return contentBlocks(message).some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(RUNTIME_CONTEXT_START),
  );
}

function removeTrailingCacheControl(message: PayloadRecord): unknown {
  const blocks = contentBlocks(message);
  const lastBlock = blocks.at(-1);
  if (!lastBlock || !("cache_control" in lastBlock)) {
    return undefined;
  }
  const cacheControl = lastBlock.cache_control;
  delete lastBlock.cache_control;
  return cacheControl;
}

function markLastCacheableBlock(
  messages: PayloadRecord[],
  endExclusive: number,
  cacheControl: unknown,
): void {
  for (let index = endExclusive - 1; index >= 0; index -= 1) {
    const blocks = contentBlocks(messages[index]!);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      if (
        typeof block.type === "string" &&
        CACHEABLE_CONTENT_TYPES.has(block.type)
      ) {
        block.cache_control = cacheControl;
        return;
      }
    }
  }
}

/** Keep the first call of a Turn's volatile runtime context outside the prompt cache. */
export function keepRuntimeContextOutsidePromptCache(
  payload: unknown,
  model: Model<any>,
): unknown | undefined {
  if (model.api !== "anthropic-messages") {
    return undefined;
  }
  const body = record(payload);
  if (!body || !Array.isArray(body.messages) || body.messages.length < 2) {
    return undefined;
  }
  const messages = body.messages.flatMap((value) => {
    const message = record(value);
    return message ? [message] : [];
  });
  if (messages.length !== body.messages.length) {
    return undefined;
  }

  const contextIndex = messages.length - 2;
  if (!containsRuntimeContext(messages[contextIndex]!)) {
    return undefined;
  }

  const cacheControl = removeTrailingCacheControl(messages.at(-1)!);
  if (cacheControl === undefined) {
    return undefined;
  }
  markLastCacheableBlock(messages, contextIndex, cacheControl);
  return body;
}
