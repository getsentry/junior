import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import {
  readAllConversationUpdates,
  readConversationData,
  readConversationEvents,
  readConversationUpdates,
} from "../src/client/api";

const generatedAt = "2026-07-23T00:00:00.000Z";

function conversationDetail(): ConversationDetailReport {
  return {
    conversationId: "slack:C1:123",
    cumulativeDurationMs: 0,
    displayTitle: "Conversation",
    eventCursor: "fresh-cursor",
    eventHistory: { status: "available" },
    events: [],
    generatedAt,
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    modelUsage: [],
    startedAt: generatedAt,
    status: "active",
    surface: "slack",
  };
}

function messageEvent(seq: number, text: string) {
  return {
    createdAt: generatedAt,
    data: {
      type: "message" as const,
      messageId: `message-${seq}`,
      role: "assistant" as const,
      text,
    },
    seq,
  };
}

describe("dashboard client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarts Google sign-in when product API auth expires", async () => {
    const assign = vi.fn();
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "unauthenticated" }, { status: 401 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "?filter=recent",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 401",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123",
      { credentials: "same-origin" },
    );
    expect(assign).toHaveBeenCalledWith(
      "/auth/login?next=%2Fconversations%3Ffilter%3Drecent",
    );
  });

  it("requests only events after the supplied cursor", async () => {
    const response = {
      conversationId: "slack:C1:123",
      displayTitle: "Conversation",
      cumulativeDurationMs: 0,
      isParticipant: true,
      status: "active",
      startedAt: "2026-07-23T00:00:00.000Z",
      lastSeenAt: "2026-07-23T00:00:00.000Z",
      lastProgressAt: "2026-07-23T00:00:00.000Z",
      surface: "slack",
      events: [],
      eventHistory: { status: "available" },
      eventCursor: "next-cursor",
      generatedAt: "2026-07-23T00:00:00.000Z",
      hasMore: false,
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 5, totalTokens: 5 },
        },
      ],
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationUpdates("slack:C1:123", "signed cursor"),
    ).resolves.toMatchObject({
      eventCursor: "next-cursor",
      events: [],
      modelUsage: [
        {
          modelId: "openai/gpt-5",
          usage: { inputTokens: 5, totalTokens: 5 },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123/updates?cursor=signed+cursor",
      { credentials: "same-origin" },
    );
  });

  it("requests the event collection before the supplied cursor", async () => {
    const response = {
      events: [],
      eventHistory: { status: "available" },
      generatedAt: "2026-07-23T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationEvents("slack:C1:123", "history cursor"),
    ).resolves.toMatchObject({ events: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123/events?before=history+cursor",
      { credentials: "same-origin" },
    );
  });

  it("refreshes invalid cursors without discarding loaded history", async () => {
    const refreshed: ConversationDetailReport = {
      ...conversationDetail(),
      events: [messageEvent(2, "Current event"), messageEvent(3, "New event")],
      previousCursor: "fresh-before",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Invalid conversation cursor." },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json(refreshed));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readAllConversationUpdates("slack:C1:123", {
        ...refreshed,
        eventCursor: "expired-cursor",
        events: [
          messageEvent(0, "Loaded earlier event"),
          messageEvent(2, "Current event"),
        ],
        previousCursor: "expired-before",
      }),
    ).resolves.toEqual({
      ...refreshed,
      events: [
        messageEvent(0, "Loaded earlier event"),
        messageEvent(2, "Current event"),
        messageEvent(3, "New event"),
      ],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/conversations/slack%3AC1%3A123/updates?cursor=expired-cursor",
      { credentials: "same-origin" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/conversations/slack%3AC1%3A123",
      { credentials: "same-origin" },
    );
  });

  it("does not hide non-cursor update failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "unavailable" }, { status: 503 }),
      ),
    );

    await expect(
      readAllConversationUpdates("slack:C1:123", {
        ...conversationDetail(),
        eventCursor: "current-cursor",
      }),
    ).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123/updates?cursor=current-cursor returned 503",
    );
  });

  it("does not redirect for non-auth product API failures", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 403",
    );

    expect(assign).not.toHaveBeenCalled();
  });
});
