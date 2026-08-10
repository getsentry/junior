import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  apiErrorSchema,
  conversationDetailReportSchema,
  conversationEventPageSchema,
  type ConversationReportEvent,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getSqlExecutor,
  getConversationStore,
} from "@/chat/db";
import { purgeConversation } from "@/chat/conversations/retention";

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

function assistantMessage(createdAtMs: number, inputTokens = 0) {
  return {
    data: {
      type: "assistant_message" as const,
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
    },
    createdAtMs,
  };
}

describe("conversation event list API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("pages backward without gaps", async () => {
    const conversationId = "internal:paged-events";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      message("message-1", 1),
      assistantMessage(2),
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
          type: "subagent",
          startedSeq: 4,
          startedAt: "1970-01-01T00:00:00.005Z",
          childConversationId: "child-1",
          subagentKind: "review",
          status: "completed",
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
      "subagent",
      "subagent",
    ]);
  });

  it("reports privacy-safe Guardian decisions", async () => {
    const conversationId = "internal:guardian-events";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "guardian_action_reviewed",
          turnId: "turn-guardian",
          toolCallId: "tool-guardian",
          toolName: "createIssue",
          decision: "allow",
          riskLevel: "medium",
          userAuthorization: "high",
        },
        createdAtMs: 2,
      },
    ]);

    const response = await createJuniorApi().request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    expect(response.status).toBe(200);
    const detail = conversationDetailReportSchema.parse(await response.json());
    expect(detail.events).toEqual([
      expect.objectContaining({
        data: {
          type: "guardian_action_reviewed",
          turnId: "turn-guardian",
          toolCallId: "tool-guardian",
          toolName: "createIssue",
          decision: "allow",
          riskLevel: "medium",
          userAuthorization: "high",
        },
      }),
    ]);
  });

  it("keeps a history page self-contained when a subagent start is older", async () => {
    const conversationId = "internal:paged-subagent";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "subagent_started",
          subagentInvocationId: "invocation-before-page",
          subagentKind: "advisor",
          childConversationId: "child-before-page",
          parentToolCallId: "advisor-before-page",
        },
        createdAtMs: 2,
      },
      {
        data: {
          type: "subagent_ended",
          subagentInvocationId: "invocation-before-page",
          outcome: "error",
        },
        createdAtMs: 3,
      },
      message("latest-message", 4),
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events.map((event) => event.seq)).toEqual([2]);
    if (!detail.previousCursor) throw new Error("Expected a previous cursor");

    const historyResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(detail.previousCursor)}&limit=1`,
    );
    expect(historyResponse.status).toBe(200);
    const history = conversationEventPageSchema.parse(
      await historyResponse.json(),
    );
    expect(history.events).toEqual([
      expect.objectContaining({
        data: {
          type: "subagent",
          startedSeq: 0,
          startedAt: "1970-01-01T00:00:00.002Z",
          childConversationId: "child-before-page",
          subagentKind: "advisor",
          parentToolCallId: "advisor-before-page",
          status: "error",
        },
      }),
    ]);
  });

  it("keeps a terminal tool observation self-contained when its start is older", async () => {
    const conversationId = "internal:paged-tool";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "tool_execution_started",
          toolCallId: "search-before-page",
          toolName: "search",
        },
        createdAtMs: 2,
      },
      {
        data: {
          type: "tool_result",
          toolCallId: "search-before-page",
          toolName: "search",
          content: [{ type: "text", text: "two matches" }],
          isError: false,
          timestamp: 3,
        },
        createdAtMs: 3,
      },
      message("latest-message", 4),
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    if (!detail.previousCursor) throw new Error("Expected a previous cursor");

    const historyResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(detail.previousCursor)}&limit=1`,
    );
    expect(historyResponse.status).toBe(200);
    const history = conversationEventPageSchema.parse(
      await historyResponse.json(),
    );
    expect(history.events).toEqual([
      expect.objectContaining({
        data: {
          type: "tool_calls",
          calls: [
            {
              toolCallId: "search-before-page",
              name: "search",
              status: "completed",
              startedSeq: 0,
              startedAt: "1970-01-01T00:00:00.002Z",
            },
          ],
        },
      }),
    ]);
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
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
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
    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.eventHistory.status).toBe("redacted");
    expect(refreshed.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-3",
      role: "assistant",
      redacted: true,
    });

    const participantApi = new Hono<{ Variables: JuniorApiVariables }>();
    participantApi.use("*", async (context, next) => {
      const viewer = await resolveViewerUser("participant@example.COM");
      if (!viewer) {
        throw new Error("missing viewer for participant@example.COM");
      }
      context.set("viewer", viewer);
      await next();
    });
    participantApi.route("/", createJuniorApi());

    const participantHistoryResponse = await participantApi.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/events?before=${encodeURIComponent(detail.previousCursor)}`,
    );
    const participantHistory = conversationEventPageSchema.parse(
      await participantHistoryResponse.json(),
    );
    expect(participantHistory.eventHistory.status).toBe("available");
    expect(participantHistory.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-1",
      role: "assistant",
      text: "private-message-1",
    });

    const participantDetailResponse = await participantApi.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}?limit=1`,
    );
    const participantDetail = conversationDetailReportSchema.parse(
      await participantDetailResponse.json(),
    );
    expect(participantDetail.eventHistory.status).toBe("available");
    expect(participantDetail.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-3",
      role: "assistant",
      text: "private-message-3",
    });
  });

  it("returns expired history and detail after retention purge", async () => {
    const conversationId = "internal:expired-paged-events";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      message("expired-message-1", 1),
      assistantMessage(2, 5),
      message("expired-message-2", 3),
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    if (!detail.previousCursor) throw new Error("Expected a previous cursor");

    await purgeConversation(getSqlExecutor(), conversationId, { nowMs: 50 });

    const historyResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(detail.previousCursor)}`,
    );
    const history = conversationEventPageSchema.parse(
      await historyResponse.json(),
    );
    expect(history).toMatchObject({
      eventHistory: {
        status: "expired",
        expiredAt: new Date(50).toISOString(),
      },
      events: [],
    });
    expect(history.previousCursor).toBeUndefined();

    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed).toMatchObject({
      eventHistory: {
        status: "expired",
        expiredAt: new Date(50).toISOString(),
      },
      events: [],
    });
    expect(refreshed.modelUsage).toBeUndefined();
  });
});
