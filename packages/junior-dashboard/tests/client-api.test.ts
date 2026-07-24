import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationReportEvent,
  ConversationUpdatesReport,
} from "@sentry/junior/api/schema";

import {
  readConversationData,
  readConversationEvents,
  readConversationUpdateBatch,
  readConversationUpdates,
} from "../src/client/api";

const generatedAt = "2026-07-23T00:00:00.000Z";

function event(seq: number): ConversationReportEvent {
  return {
    createdAt: generatedAt,
    data: {
      type: "message_handled",
      messageId: `message-${seq}`,
    },
    seq,
  };
}

function update(
  eventCursor: string,
  events: ConversationReportEvent[],
  hasMore: boolean,
  status: ConversationUpdatesReport["status"] = "active",
): ConversationUpdatesReport {
  return {
    conversationId: "slack:C1:123",
    cumulativeDurationMs: events.length,
    displayTitle: "Conversation",
    eventCursor,
    eventHistory: { status: "available" },
    events,
    generatedAt,
    hasMore,
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status,
    surface: "slack",
  };
}

describe("dashboard client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarts Google sign-in when product API auth expires", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "unauthenticated" }, { status: 401 }),
      ),
    );
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
    expect(assign).toHaveBeenCalledWith(
      "/auth/login?next=%2Fconversations%3Ffilter%3Drecent",
    );
  });

  it("requests updates after the supplied cursor", async () => {
    const response = update("next-cursor", [], false);
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationUpdates("slack:C1:123", "signed cursor"),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123/updates?cursor=signed+cursor",
      { credentials: "same-origin" },
    );
  });

  it("requests older events before the supplied cursor", async () => {
    const response = {
      events: [event(1)],
      eventHistory: { status: "available" as const },
      generatedAt,
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationEvents("slack:C1:123", "history cursor"),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123/events?before=history+cursor",
      { credentials: "same-origin" },
    );
  });

  it("rejects a history page whose cursor does not advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          events: [],
          eventHistory: { status: "available" },
          generatedAt,
          previousCursor: "same-cursor",
        }),
      ),
    );

    await expect(
      readConversationEvents("slack:C1:123", "same-cursor"),
    ).rejects.toThrow("Conversation history cursor did not advance");
  });

  it("drains a bounded update feed into one query result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(update("cursor-2", [event(2), event(3)], true)),
      )
      .mockResolvedValueOnce(
        Response.json(update("cursor-3", [event(3), event(4)], false)),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationUpdateBatch("slack:C1:123", "cursor-1"),
    ).resolves.toMatchObject({
      eventCursor: "cursor-3",
      events: [event(2), event(3), event(4)],
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/conversations/slack%3AC1%3A123/updates?cursor=cursor-2",
      { credentials: "same-origin" },
    );
  });

  it("rejects an update feed whose cursor does not advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(update("same-cursor", [event(2)], true))),
    );

    await expect(
      readConversationUpdateBatch("slack:C1:123", "same-cursor"),
    ).rejects.toThrow("Conversation update cursor did not advance");
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
