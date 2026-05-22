import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@/chat/coerce";
import type { PiMessage } from "@/chat/pi/messages";
import { getStateAdapter } from "./adapter";

const PI_SESSION_MESSAGE_PREFIX = "junior:pi_session_message";

interface PiSessionScope {
  conversationId: string;
  sessionId: string;
}

function piSessionMessageKey(scope: PiSessionScope, index: number): string {
  return `${PI_SESSION_MESSAGE_PREFIX}:${scope.conversationId}:${scope.sessionId}:${index}`;
}

function parsePiMessage(value: unknown): PiMessage | undefined {
  return isRecord(value) ? (value as unknown as PiMessage) : undefined;
}

function normalizeMessageCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countMatchingPrefix(left: PiMessage[], right: PiMessage[]): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (!isDeepStrictEqual(left[index], right[index])) {
      return index;
    }
  }
  return limit;
}

/** Load the exact stable Pi message prefix for a session. */
export async function loadPiSessionMessages(
  args: PiSessionScope & {
    messageCount: number;
  },
): Promise<PiMessage[] | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const messageCount = normalizeMessageCount(args.messageCount);
  if (messageCount === 0) {
    return [];
  }

  const values = await Promise.all(
    Array.from({ length: messageCount }, (_, index) =>
      stateAdapter.get(piSessionMessageKey(args, index)),
    ),
  );

  const messages: PiMessage[] = [];
  for (const value of values) {
    const message = parsePiMessage(value);
    if (!message) {
      break;
    }
    messages.push(message);
  }
  return messages.length === messageCount ? messages : undefined;
}

/**
 * Load as many Pi session messages as are actually present in Redis, stopping at
 * the first missing slot. Used by the commit path to determine the safe write start
 * index without requiring an exact count match.
 */
async function loadExistingPiSessionMessages(
  scope: PiSessionScope,
  maxCount: number,
): Promise<PiMessage[]> {
  const count = normalizeMessageCount(maxCount);
  if (count === 0) {
    return [];
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const values = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      stateAdapter.get(piSessionMessageKey(scope, index)),
    ),
  );

  const messages: PiMessage[] = [];
  for (const value of values) {
    const message = parsePiMessage(value);
    if (!message) {
      break;
    }
    messages.push(message);
  }
  return messages;
}

/** Commit new stable Pi messages before the caller advances its cursor. */
export async function commitPiSessionMessages(
  args: PiSessionScope & {
    messages: PiMessage[];
    ttlMs: number;
  },
): Promise<void> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const existingMessages = await loadExistingPiSessionMessages(
    { conversationId: args.conversationId, sessionId: args.sessionId },
    args.messages.length,
  );
  const writeFromIndex = countMatchingPrefix(existingMessages, args.messages);

  await Promise.all(
    args.messages
      .slice(writeFromIndex)
      .map((message, offset) =>
        stateAdapter.set(
          piSessionMessageKey(args, writeFromIndex + offset),
          message,
          args.ttlMs,
        ),
      ),
  );
}
