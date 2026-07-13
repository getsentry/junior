import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { THREAD_STATE_TTL_MS, type StateAdapter } from "chat";
import { isRecord, toOptionalString } from "@/chat/coerce";
import { getChatConfig } from "@/chat/config";
import type {
  MigrationContext,
  MigrationResult,
  UpgradeMigration,
} from "../types";

const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_INDEX_KEY = `${AGENT_TURN_SESSION_PREFIX}:index`;
const AGENT_TURN_SESSION_INDEX_MAX_LENGTH = 5_000;
const REDIS_SCAN_COUNT = 500;

type RedisCommandClient = {
  sendCommand<T = unknown>(args: readonly string[]): Promise<T>;
};

interface MigratedValue {
  changed: boolean;
  value: unknown;
}

function conversationIndexKey(conversationId: string): string {
  return `${AGENT_TURN_SESSION_PREFIX}:conversation:${conversationId}:index`;
}

function sessionRecordKey(conversationId: string, sessionId: string): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

function logicalConversationIndexPrefix(): string {
  const prefix = getChatConfig().state.keyPrefix;
  return [
    ...(prefix ? [prefix] : []),
    `${AGENT_TURN_SESSION_PREFIX}:conversation:`,
  ].join(":");
}

function conversationIdFromRedisListKey(key: string): string | undefined {
  const marker = `:list:${logicalConversationIndexPrefix()}`;
  const markerIndex = key.indexOf(marker);
  if (markerIndex < 0 || !key.endsWith(":index")) {
    return undefined;
  }
  return toOptionalString(
    key.slice(markerIndex + marker.length, -":index".length),
  );
}

async function discoverRedisConversationIds(
  redisStateAdapter: RedisStateAdapter | undefined,
): Promise<string[]> {
  const client = redisStateAdapter?.getClient() as
    | RedisCommandClient
    | undefined;
  if (!client) {
    return [];
  }

  const conversationIds = new Set<string>();
  const match = `*:list:${logicalConversationIndexPrefix()}*:index`;
  let cursor = "0";
  do {
    const reply = await client.sendCommand<unknown>([
      "SCAN",
      cursor,
      "MATCH",
      match,
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
        "Unexpected Redis SCAN response while migrating turn sessions",
      );
    }
    cursor = String(reply[0]);
    for (const key of reply[1]) {
      if (typeof key !== "string") {
        continue;
      }
      const conversationId = conversationIdFromRedisListKey(key);
      if (conversationId) {
        conversationIds.add(conversationId);
      }
    }
  } while (cursor !== "0");

  return [...conversationIds];
}

function migrateRequesterToActor(value: unknown): MigratedValue {
  if (!isRecord(value) || value.requester === undefined) {
    return { changed: false, value };
  }

  const { requester, ...record } = value;
  return {
    changed: true,
    value: {
      ...record,
      ...(record.actor === undefined ? { actor: requester } : {}),
    },
  };
}

async function rewriteList(args: {
  key: string;
  maxLength?: number;
  stateAdapter: StateAdapter;
}): Promise<{ migrated: number; values: unknown[] }> {
  const values = await args.stateAdapter.getList(args.key);
  const migrated = values.map(migrateRequesterToActor);
  const changed = migrated.filter((entry) => entry.changed).length;
  if (changed === 0) {
    return { migrated: 0, values };
  }

  await args.stateAdapter.delete(args.key);
  for (const entry of migrated) {
    await args.stateAdapter.appendToList(args.key, entry.value, {
      ...(args.maxLength !== undefined ? { maxLength: args.maxLength } : {}),
      ttlMs: THREAD_STATE_TTL_MS,
    });
  }
  return { migrated: changed, values: migrated.map((entry) => entry.value) };
}

async function migrateSessionRecord(args: {
  conversationId: string;
  sessionId: string;
  stateAdapter: StateAdapter;
}): Promise<"existing" | "migrated" | "missing"> {
  const key = sessionRecordKey(args.conversationId, args.sessionId);
  const existing = await args.stateAdapter.get<unknown>(key);
  if (existing === undefined) {
    return "missing";
  }
  const migrated = migrateRequesterToActor(existing);
  if (!migrated.changed) {
    return "existing";
  }
  await args.stateAdapter.set(key, migrated.value, THREAD_STATE_TTL_MS);
  return "migrated";
}

async function migrateAgentTurnSessionActor(
  context: MigrationContext,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    existing: 0,
    migrated: 0,
    missing: 0,
    scanned: 0,
  };
  const global = await rewriteList({
    key: AGENT_TURN_SESSION_INDEX_KEY,
    maxLength: AGENT_TURN_SESSION_INDEX_MAX_LENGTH,
    stateAdapter: context.stateAdapter,
  });
  result.scanned += global.values.length;
  result.migrated += global.migrated;

  const conversations = new Set<string>();
  const sessions = new Set<string>();
  for (const conversationId of await discoverRedisConversationIds(
    context.redisStateAdapter,
  )) {
    conversations.add(conversationId);
  }
  for (const value of global.values) {
    if (!isRecord(value)) {
      continue;
    }
    const conversationId = toOptionalString(value.conversationId);
    const sessionId = toOptionalString(value.sessionId);
    if (!conversationId) {
      continue;
    }
    conversations.add(conversationId);
    if (sessionId) {
      sessions.add(`${conversationId}\u0000${sessionId}`);
    }
  }

  for (const conversationId of conversations) {
    const conversation = await rewriteList({
      key: conversationIndexKey(conversationId),
      stateAdapter: context.stateAdapter,
    });
    result.scanned += conversation.values.length;
    result.migrated += conversation.migrated;
    for (const value of conversation.values) {
      if (!isRecord(value)) {
        continue;
      }
      const sessionId = toOptionalString(value.sessionId);
      if (sessionId) {
        sessions.add(`${conversationId}\u0000${sessionId}`);
      }
    }
  }

  for (const session of sessions) {
    const separator = session.indexOf("\u0000");
    const conversationId = session.slice(0, separator);
    const sessionId = session.slice(separator + 1);
    result.scanned += 1;
    const status = await migrateSessionRecord({
      conversationId,
      sessionId,
      stateAdapter: context.stateAdapter,
    });
    if (status === "migrated") {
      result.migrated += 1;
    } else if (status === "existing") {
      result.existing += 1;
    } else {
      result.missing += 1;
    }
  }

  return result;
}

export const agentTurnSessionActorMigration: UpgradeMigration = {
  name: "migrate-agent-turn-session-requester-to-actor",
  run: migrateAgentTurnSessionActor,
};
