import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { getChatConfig } from "@/chat/config";
import { isRecord, toOptionalString } from "@/chat/coerce";
import type { MigrationContext } from "../types";
import {
  AGENT_TURN_SESSION_PREFIX,
  agentTurnSessionConversationIndexKey,
  agentTurnSessionKey,
} from "@/chat/state/turn-session-keys";

const REDIS_SCAN_COUNT = 500;

type RedisCommandClient = {
  sendCommand<T = unknown>(args: readonly string[]): Promise<T>;
};

function rawTurnSessionKeyPattern(): string {
  const statePrefix = getChatConfig().state.keyPrefix;
  return `*:cache:${statePrefix ? `${statePrefix}:` : ""}${AGENT_TURN_SESSION_PREFIX}:*`;
}

function logicalStateKey(rawKey: string): string | undefined {
  const statePrefix = getChatConfig().state.keyPrefix;
  const cachePrefix = `:cache:${statePrefix ? `${statePrefix}:` : ""}`;
  const cacheAt = rawKey.indexOf(cachePrefix);
  return cacheAt < 0 ? undefined : rawKey.slice(cacheAt + cachePrefix.length);
}

async function discoverRawTurnSessionKeys(
  redisStateAdapter: RedisStateAdapter | undefined,
  conversationIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const client = redisStateAdapter?.getClient() as
    | RedisCommandClient
    | undefined;
  const discovered = new Map<string, string>();
  if (!client) return discovered;
  const targetKeyPrefixes = [...conversationIds].map(
    (conversationId) => `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:`,
  );

  let cursor = "0";
  do {
    const reply = await client.sendCommand<unknown>([
      "SCAN",
      cursor,
      "MATCH",
      rawTurnSessionKeyPattern(),
      "COUNT",
      String(REDIS_SCAN_COUNT),
    ]);
    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      (typeof reply[0] !== "string" && typeof reply[0] !== "number") ||
      !Array.isArray(reply[1])
    ) {
      throw new Error(
        "Unexpected Redis SCAN response while checking turn-session cursors",
      );
    }
    cursor = String(reply[0]);
    for (const rawKey of reply[1]) {
      if (typeof rawKey !== "string") continue;
      const logicalKey = logicalStateKey(rawKey);
      if (
        !logicalKey ||
        !targetKeyPrefixes.some((prefix) => logicalKey.startsWith(prefix))
      ) {
        continue;
      }
      const encoded = await client.sendCommand<unknown>(["GET", rawKey]);
      if (encoded === null) continue;
      if (typeof encoded !== "string") {
        throw new Error(`Turn-session cursor ${rawKey} is not JSON text`);
      }
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (error) {
        throw new Error(`Turn-session cursor ${rawKey} is invalid JSON`, {
          cause: error,
        });
      }
      if (!isRecord(value)) {
        throw new Error(`Turn-session cursor ${rawKey} is not an object`);
      }
      const conversationId = toOptionalString(value.conversationId);
      const sessionId = toOptionalString(value.sessionId);
      if (!conversationId || !sessionId) {
        throw new Error(`Turn-session cursor ${rawKey} has no identity`);
      }
      const recordKey = agentTurnSessionKey(conversationId, sessionId);
      if (logicalKey !== recordKey) {
        throw new Error(
          `Turn-session cursor ${rawKey} identity does not match its key`,
        );
      }
      if (!conversationIds.has(conversationId)) continue;
      discovered.set(recordKey, conversationId);
    }
  } while (cursor !== "0");

  return discovered;
}

async function indexedTurnSessionIds(
  context: MigrationContext,
  conversationId: string,
): Promise<string[]> {
  const summaries = await context.stateAdapter.getList(
    agentTurnSessionConversationIndexKey(conversationId),
  );
  return [
    ...new Set(
      summaries.flatMap((summary) => {
        if (!isRecord(summary)) return [];
        const sessionId = toOptionalString(summary.sessionId);
        return sessionId ? [sessionId] : [];
      }),
    ),
  ];
}

function hasSeqCursor(record: Record<string, unknown>): boolean {
  return (
    Number.isInteger(record.committedSeq) ||
    Number.isInteger(record.turnStartSeq)
  );
}

/**
 * Drain or discard Redis turn cursors before changing physical SQL event seqs.
 * Running and resumable turns abort the upgrade; completed records are stale
 * after resequencing and are deleted.
 */
export async function prepareConversationEventResequence(
  context: MigrationContext,
  conversationIds: ReadonlySet<string>,
): Promise<void> {
  if (conversationIds.size === 0) return;
  await context.stateAdapter.connect();

  const keys = new Set<string>();
  for (const conversationId of conversationIds) {
    for (const sessionId of await indexedTurnSessionIds(
      context,
      conversationId,
    )) {
      keys.add(agentTurnSessionKey(conversationId, sessionId));
    }
  }
  for (const [key] of await discoverRawTurnSessionKeys(
    context.redisStateAdapter,
    conversationIds,
  )) {
    keys.add(key);
  }

  const terminalKeys: string[] = [];
  for (const key of keys) {
    const value = await context.stateAdapter.get<unknown>(key);
    if (!isRecord(value) || !hasSeqCursor(value)) continue;
    if (value.state === "running" || value.state === "awaiting_resume") {
      throw new Error(
        `Cannot resequence conversation events while unfinished turn session ${key} retains a seq cursor`,
      );
    }
    if (
      value.state !== "completed" &&
      value.state !== "failed" &&
      value.state !== "abandoned"
    ) {
      throw new Error(
        `Cannot resequence conversation events with invalid cursor-bearing turn session ${key}`,
      );
    }
    terminalKeys.push(key);
  }

  for (const key of terminalKeys) {
    await context.stateAdapter.delete(key);
  }
}
