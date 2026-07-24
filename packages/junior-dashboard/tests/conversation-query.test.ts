import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  ConversationDetailReport,
  ConversationEventPage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

import {
  applyCompleteConversationHistory,
  applyConversationEventPage,
} from "../src/client/conversation-query";

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
    modelUsage: [],
    previousCursor: "before-3",
    startedAt: generatedAt,
    status: "active",
    surface: "internal",
  };
}

describe("conversation query", () => {
  it("preserves live updates when committing complete history", async () => {
    const queryClient = new QueryClient();
    const current = {
      ...detail(),
      cumulativeDurationMs: 20,
      eventCursor: "new-live-cursor",
      events: [event(3), event(4), event(5)],
    };
    queryClient.setQueryData(["conversation", "conversation-1"], current);
    await applyCompleteConversationHistory(queryClient, "conversation-1", {
      ...detail(),
      events: [event(1), event(2), event(3), event(4)],
      previousCursor: undefined,
    });

    expect(
      queryClient.getQueryData<ConversationDetailReport>([
        "conversation",
        "conversation-1",
      ]),
    ).toMatchObject({
      cumulativeDurationMs: 20,
      eventCursor: "new-live-cursor",
      events: [event(1), event(2), event(3), event(4), event(5)],
      previousCursor: undefined,
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

    await applyConversationEventPage(queryClient, "conversation-1", page);
    resolvePoll({ ...detail(), events: [event(3), event(4), event(5)] });
    await poll;

    expect(
      queryClient.getQueryData<ConversationDetailReport>(queryKey)?.events,
    ).toEqual([event(1), event(2), event(3), event(4)]);
  });

  it("applies history only to the requested conversation", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["conversation", "conversation-1"], detail());
    queryClient.setQueryData(["conversation", "conversation-2"], {
      ...detail(),
      conversationId: "conversation-2",
      events: [event(10)],
    });

    await applyConversationEventPage(queryClient, "conversation-1", {
      events: [event(1), event(2)],
      eventHistory: { status: "available" },
      generatedAt,
    });

    expect(
      queryClient.getQueryData<ConversationDetailReport>([
        "conversation",
        "conversation-1",
      ])?.events,
    ).toEqual([event(1), event(2), event(3), event(4)]);
    expect(
      queryClient.getQueryData<ConversationDetailReport>([
        "conversation",
        "conversation-2",
      ])?.events,
    ).toEqual([event(10)]);
  });
});
