import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { personalSpendRefreshDelay } from "../src/client/api";
import {
  conversationDetailQueryOptions,
  readConversationData,
  readConversationEvents,
} from "../src/client/conversations/queries";

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

  it("keeps polling active detail after a failed refresh", () => {
    const options = conversationDetailQueryOptions("slack:C1:123");
    const interval = options.refetchInterval;
    if (typeof interval !== "function") {
      throw new Error("Expected a dynamic polling interval");
    }
    const query = {
      state: {
        data: {
          conversationId: "slack:C1:123",
          cumulativeDurationMs: 1,
          displayTitle: "Active conversation",
          eventHistory: { status: "available" },
          events: [],
          generatedAt,
          isParticipant: true,
          lastProgressAt: generatedAt,
          lastSeenAt: generatedAt,
          startedAt: generatedAt,
          status: "active",
          surface: "slack",
        },
        error: new Error("temporary failure"),
      },
    } as unknown as Parameters<typeof interval>[0];

    expect(interval(query)).toBe(2_000);
  });

  it("refreshes spend from the age of the server-cached report", () => {
    const nowMs = Date.parse("2026-08-03T12:00:00.000Z");

    expect(personalSpendRefreshDelay(undefined, nowMs)).toBe(5 * 60_000);
    expect(personalSpendRefreshDelay("2026-08-03T11:55:30.000Z", nowMs)).toBe(
      30_000,
    );
    expect(personalSpendRefreshDelay("2026-08-03T11:54:00.000Z", nowMs)).toBe(
      1_000,
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
