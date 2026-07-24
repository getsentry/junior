import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { createJuniorApi } from "@/api";
import {
  apiErrorSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationUpdatesReportSchema,
  type ConversationReportEvent,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";

async function recordConversation(conversationId: string): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    nowMs: 1,
    source: "internal",
    title: "Paged conversation",
  });
}

function message(messageId: string, createdAtMs: number) {
  return {
    data: {
      type: "message" as const,
      messageId,
      role: "assistant" as const,
      text: messageId,
    },
    createdAtMs,
  };
}

function textAgentStep(createdAtMs: number, inputTokens = 0) {
  return {
    data: {
      type: "agent_step" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "not a reporting event" }],
        api: "responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        timestamp: createdAtMs,
        usage: {
          input: inputTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens,
          cost: {
            input: inputTokens / 1_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: inputTokens / 1_000,
          },
        },
      } as PiMessage,
    },
    createdAtMs,
  };
}

describe("conversation event REST resources", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("delivers the first event appended after an empty snapshot", async () => {
    const conversationId = "internal:empty-event-cursor";
    await recordConversation(conversationId);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([]);

    await getConversationEventStore().append(conversationId, [
      message("first-message", 2),
    ]);
    const updatesResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/updates?cursor=${encodeURIComponent(detail.eventCursor)}`,
    );
    const updates = conversationUpdatesReportSchema.parse(
      await updatesResponse.json(),
    );
    expect(updates.events.map((event) => event.seq)).toEqual([0]);
    expect(updates.hasMore).toBe(false);
  });

  it("pages backward without gaps and advances bounded forward updates", async () => {
    const conversationId = "internal:paged-events";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      message("message-1", 1),
      textAgentStep(2),
      message("message-2", 3),
      message("message-3", 4),
      {
        data: {
          type: "subagent_started",
          subagentInvocationId: "invocation-1",
          subagentKind: "review",
          childConversationId: "child-1",
        },
        createdAtMs: 5,
      },
      {
        data: {
          type: "subagent_ended",
          subagentInvocationId: "invocation-1",
          outcome: "success",
        },
        createdAtMs: 6,
      },
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}?limit=1`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([
      expect.objectContaining({
        data: {
          type: "subagent_ended",
          startedSeq: 4,
          outcome: "success",
        },
      }),
    ]);
    expect(detail.previousCursor).toBeDefined();

    const pages: ConversationReportEvent[][] = [detail.events];
    let before = detail.previousCursor;
    while (before) {
      const response = await app.request(
        `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(before)}&limit=2`,
      );
      expect(response.status).toBe(200);
      const page = conversationEventPageSchema.parse(await response.json());
      pages.unshift(page.events);
      before = page.previousCursor;
    }
    const events = pages.flat();
    expect(events.map((event) => event.seq)).toEqual([0, 2, 3, 4, 5]);
    expect(events.map((event) => event.data.type)).toEqual([
      "message",
      "message",
      "message",
      "subagent_started",
      "subagent_ended",
    ]);

    await getConversationEventStore().append(conversationId, [
      textAgentStep(7, 5),
      message("message-4", 8),
      message("message-5", 9),
    ]);

    const firstUpdateResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/updates?cursor=${encodeURIComponent(detail.eventCursor)}&limit=1`,
    );
    expect(firstUpdateResponse.status).toBe(200);
    const firstUpdate = conversationUpdatesReportSchema.parse(
      await firstUpdateResponse.json(),
    );
    expect(firstUpdate.events.map((event) => event.seq)).toEqual([7]);
    expect(firstUpdate.hasMore).toBe(true);
    expect(firstUpdate.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 5,
          totalTokens: 5,
        }),
      },
    ]);

    const secondUpdateResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/updates?cursor=${encodeURIComponent(firstUpdate.eventCursor)}&limit=1`,
    );
    expect(secondUpdateResponse.status).toBe(200);
    const secondUpdate = conversationUpdatesReportSchema.parse(
      await secondUpdateResponse.json(),
    );
    expect(secondUpdate.events.map((event) => event.seq)).toEqual([8]);
    expect(secondUpdate.hasMore).toBe(false);
  });

  it("rejects tampered, cross-conversation, and invalid pagination input", async () => {
    const firstConversationId = "internal:first-cursor-owner";
    const secondConversationId = "internal:second-cursor-owner";
    await recordConversation(firstConversationId);
    await recordConversation(secondConversationId);
    await getConversationEventStore().append(firstConversationId, [
      message("first-message", 1),
      message("second-message", 2),
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${firstConversationId}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    const previousCursor = detail.previousCursor;
    if (!previousCursor) throw new Error("Expected a previous cursor");

    const tampered = `${previousCursor.slice(0, -1)}${
      previousCursor.endsWith("a") ? "b" : "a"
    }`;
    for (const [conversationId, cursor] of [
      [firstConversationId, tampered],
      [secondConversationId, previousCursor],
    ]) {
      const response = await app.request(
        `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json())).toEqual({
        error: "Invalid conversation cursor.",
      });
    }

    const invalidLimit = await app.request(
      `http://localhost/api/conversations/${firstConversationId}/events?before=${encodeURIComponent(previousCursor)}&limit=1001`,
    );
    expect(invalidLimit.status).toBe(400);
    expect(apiErrorSchema.parse(await invalidLimit.json())).toEqual({
      error: "Invalid query parameters.",
    });
  });

  it("preserves transcript redaction across history and update pages", async () => {
    const conversationId = "slack:C-private:paged-events";
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "C-private",
        platform: "slack",
        teamId: "T-private",
      },
      nowMs: 1,
      source: "slack",
      title: "Private paged conversation",
      visibility: "private",
    });
    await getConversationEventStore().append(conversationId, [
      message("private-message-1", 1),
      message("private-message-2", 2),
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.eventHistory.status).toBe("redacted");
    expect(detail.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-2",
      role: "assistant",
      redacted: true,
    });
    if (!detail.previousCursor) throw new Error("Expected a previous cursor");

    const historyResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/events?before=${encodeURIComponent(detail.previousCursor)}`,
    );
    const history = conversationEventPageSchema.parse(
      await historyResponse.json(),
    );
    expect(history.eventHistory.status).toBe("redacted");
    expect(history.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-1",
      role: "assistant",
      redacted: true,
    });

    await getConversationEventStore().append(conversationId, [
      message("private-message-3", 3),
    ]);
    const updatesResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/updates?cursor=${encodeURIComponent(detail.eventCursor)}`,
    );
    const updates = conversationUpdatesReportSchema.parse(
      await updatesResponse.json(),
    );
    expect(updates.eventHistory.status).toBe("redacted");
    expect(updates.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-3",
      role: "assistant",
      redacted: true,
    });
  });
});
