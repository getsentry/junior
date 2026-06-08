import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  listActiveConversationIds,
  listConversationsByActivity,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { SLACK_DESTINATION } from "../../fixtures/conversation-work";

const redis = vi.hoisted(() => {
  const defaultSendCommand = async (
    args: readonly string[],
  ): Promise<number | unknown[]> => {
    if (
      args[0] === "ZRANGE" ||
      args[0] === "ZREVRANGE" ||
      args[0] === "ZRANGEBYSCORE"
    ) {
      return [];
    }
    return 1;
  };
  const sendCommand = vi.fn(defaultSendCommand);
  return {
    defaultSendCommand,
    sendCommand,
    state: undefined as StateAdapter | undefined,
  };
});

vi.mock("@/chat/state/adapter", () => ({
  getDefaultRedisStateAdapterFor: async (state: StateAdapter) =>
    state === redis.state
      ? { getClient: () => ({ sendCommand: redis.sendCommand }) }
      : undefined,
  getStateAdapter: () => redis.state,
}));

describe("conversation index Redis storage", () => {
  afterEach(async () => {
    await redis.state?.disconnect();
    redis.state = undefined;
    redis.sendCommand.mockReset();
    redis.sendCommand.mockImplementation(redis.defaultSendCommand);
  });

  it("writes conversation indexes with Redis sorted set commands", async () => {
    redis.state = createMemoryState();

    await requestConversationWork({
      conversationId: "conversation-redis",
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
    });

    const commands = redis.sendCommand.mock.calls.map(([command]) => command);
    expect(commands[0]).toEqual([
      "EVAL",
      expect.stringContaining('redis.call("ZADD"'),
      "1",
      expect.stringMatching(
        new RegExp(`${CONVERSATION_BY_ACTIVITY_INDEX_KEY}$`),
      ),
      "1000",
      "conversation-redis",
      expect.any(String),
      "10000",
    ]);
    expect(commands[1]).toEqual([
      "ZADD",
      expect.stringMatching(new RegExp(`${CONVERSATION_ACTIVE_INDEX_KEY}$`)),
      "1000",
      "conversation-redis",
    ]);
    expect(commands[2]).toEqual([
      "PEXPIRE",
      expect.stringMatching(new RegExp(`${CONVERSATION_ACTIVE_INDEX_KEY}$`)),
      expect.any(String),
    ]);
    await expect(
      redis.state?.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toBeNull();
  });

  it("reads conversation indexes with Redis sorted set commands", async () => {
    redis.state = createMemoryState();

    await requestConversationWork({
      conversationId: "conversation-redis",
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
    });
    redis.sendCommand.mockClear();
    redis.sendCommand.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "ZRANGEBYSCORE" || args[0] === "ZREVRANGE") {
        return ["conversation-redis", "1000"];
      }
      return 1;
    });

    await expect(
      listActiveConversationIds({
        limit: 5,
        staleBeforeMs: 2_000,
        state: redis.state,
      }),
    ).resolves.toEqual(["conversation-redis"]);
    await expect(
      listConversationsByActivity({ limit: 5, state: redis.state }),
    ).resolves.toEqual([
      expect.objectContaining({ conversationId: "conversation-redis" }),
    ]);

    const commands = redis.sendCommand.mock.calls.map(([command]) => command);
    expect(commands).toContainEqual([
      "ZRANGEBYSCORE",
      expect.stringMatching(new RegExp(`${CONVERSATION_ACTIVE_INDEX_KEY}$`)),
      "-inf",
      "2000",
      "WITHSCORES",
      "LIMIT",
      "0",
      "5",
    ]);
    expect(commands).toContainEqual([
      "ZREVRANGE",
      expect.stringMatching(
        new RegExp(`${CONVERSATION_BY_ACTIVITY_INDEX_KEY}$`),
      ),
      "0",
      "4",
      "WITHSCORES",
    ]);
  });
});
