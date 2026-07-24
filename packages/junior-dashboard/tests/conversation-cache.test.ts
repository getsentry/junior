import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";
import {
  applyConversationEventPage,
  mergeConversationEventPage,
  mergeConversationUpdate,
} from "../src/client/conversation-cache";

const generatedAt = "2026-07-23T00:00:00.000Z";

function event(seq: number): ConversationReportEvent {
  return {
    seq,
    createdAt: generatedAt,
    data: {
      type: "message_handled",
      messageId: `message-${seq}`,
    },
  };
}

function detail(): ConversationDetailReport {
  return {
    conversationId: "conversation-1",
    cumulativeDurationMs: 10,
    displayTitle: "Conversation",
    eventCursor: "live-cursor",
    eventHistory: { status: "available" },
    events: [event(3), event(4)],
    generatedAt,
    isParticipant: false,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    modelUsage: [
      {
        modelId: "openai/gpt-5",
        usage: { inputTokens: 1, totalTokens: 1 },
      },
    ],
    previousCursor: "before-3",
    sentryConversationUrl: "https://sentry.example/conversation-1",
    startedAt: generatedAt,
    status: "active",
    surface: "internal",
  };
}

describe("conversation query cache", () => {
  it("prepends history without replacing the live cursor or duplicating events", () => {
    const page: ConversationEventPage = {
      events: [event(1), event(2), event(3)],
      eventHistory: { status: "available" },
      generatedAt,
    };

    expect(mergeConversationEventPage(detail(), page)).toMatchObject({
      eventCursor: "live-cursor",
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
      sentryConversationUrl: "https://sentry.example/conversation-1",
    });
  });

  it("appends updates while preserving detail-only fields", () => {
    const update: ConversationUpdatesReport = {
      conversationId: "conversation-1",
      cumulativeDurationMs: 20,
      displayTitle: "Updated conversation",
      eventCursor: "next-cursor",
      eventHistory: { status: "available" },
      events: [event(4), event(5)],
      generatedAt,
      hasMore: false,
      isParticipant: false,
      lastProgressAt: generatedAt,
      lastSeenAt: generatedAt,
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 2, totalTokens: 2 },
        },
      ],
      startedAt: generatedAt,
      status: "completed",
      surface: "internal",
    };

    expect(mergeConversationUpdate(detail(), update)).toMatchObject({
      cumulativeDurationMs: 20,
      displayTitle: "Updated conversation",
      eventCursor: "next-cursor",
      events: [event(3), event(4), event(5)],
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 2, totalTokens: 2 },
        },
      ],
      previousCursor: "before-3",
      sentryConversationUrl: "https://sentry.example/conversation-1",
      status: "completed",
    });
  });

  it("cancels a stale poll before merging an older history page", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const queryKey = ["conversation", "conversation-1"] as const;
    queryClient.setQueryData(queryKey, detail());

    let resolvePoll!: (value: ConversationDetailReport) => void;
    const poll = queryClient
      .fetchQuery({
        queryKey,
        queryFn: () =>
          new Promise<ConversationDetailReport>((resolve) => {
            resolvePoll = resolve;
          }),
      })
      .catch(() => undefined);
    const page: ConversationEventPage = {
      events: [event(1), event(2)],
      eventHistory: { status: "available" },
      generatedAt,
    };

    await expect(
      applyConversationEventPage(queryClient, queryKey, page),
    ).resolves.toBe("merged");
    resolvePoll({ ...detail(), events: [event(3), event(4), event(5)] });
    await poll;

    expect(
      queryClient.getQueryData<ConversationDetailReport>(queryKey)?.events,
    ).toEqual([event(1), event(2), event(3), event(4)]);
  });
});
