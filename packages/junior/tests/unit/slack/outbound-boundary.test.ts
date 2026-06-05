import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlackActionError } from "@/chat/slack/client";
import {
  createSlackOutboundBoundary,
  slackOutboundPolicy,
  type SlackOutboundServices,
} from "@/chat/slack/outbound";

type SlackClient = ReturnType<SlackOutboundServices["getSlackClient"]>;
type SlackRetryContext = Parameters<
  SlackOutboundServices["withSlackRetries"]
>[2];

describe("slack outbound boundary", () => {
  let client: SlackClient;
  let retryImpl: SlackOutboundServices["withSlackRetries"];
  const retryCalls: Array<{
    attempts: number | undefined;
    context: SlackRetryContext;
  }> = [];

  const services = {
    getSlackClient: () => client,
    normalizeSlackConversationId: (value) => value?.trim() || undefined,
    withSlackRetries: async (task, attempts, context) => {
      retryCalls.push({ attempts, context });
      return await retryImpl(task, attempts, context);
    },
  } satisfies SlackOutboundServices;

  const outbound = createSlackOutboundBoundary(services);

  beforeEach(() => {
    client = {} as SlackClient;
    retryCalls.length = 0;
    retryImpl = async (task) => await task();
  });

  it("passes reaction action context into retry wrapper", async () => {
    const reactionsAdd = vi.fn(async () => ({ ok: true }));
    client = {
      reactions: {
        add: reactionsAdd,
      },
    } as unknown as SlackClient;

    await outbound.addReactionToMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: "thumbsup",
    });

    expect(retryCalls).toEqual([
      {
        attempts: 3,
        context: { action: "reactions.add" },
      },
    ]);
    expect(reactionsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "thumbsup",
      }),
    );
  });

  it("passes reaction removal action context into retry wrapper", async () => {
    const reactionsRemove = vi.fn(async () => ({ ok: true }));
    client = {
      reactions: {
        remove: reactionsRemove,
      },
    } as unknown as SlackClient;

    await outbound.removeReactionFromMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: "eyes",
    });

    expect(retryCalls).toEqual([
      {
        attempts: 3,
        context: { action: "reactions.remove" },
      },
    ]);
  });

  it("treats already_reacted as idempotent success", async () => {
    retryImpl = async () => {
      throw new SlackActionError("already reacted", "already_reacted");
    };

    await expect(
      outbound.addReactionToMessage({
        channelId: "C123",
        timestamp: "1700000000.100",
        emoji: "thumbsup",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("treats no_reaction as idempotent success", async () => {
    retryImpl = async () => {
      throw new SlackActionError("no reaction", "no_reaction");
    };

    await expect(
      outbound.removeReactionFromMessage({
        channelId: "C123",
        timestamp: "1700000000.100",
        emoji: "thumbsup",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects message text above Slack's truncation limit before posting", async () => {
    await expect(
      outbound.postSlackMessage({
        channelId: "C123",
        text: "a".repeat(slackOutboundPolicy.maxMessageTextChars + 1),
      }),
    ).rejects.toThrow("40000 character truncation limit");
    expect(retryCalls).toEqual([]);
  });
});
