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
    destination: { platform: "local" as const, conversationId },
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
      content: [
        { type: "text", text: "answer text stays on the visible message" },
      ],
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

/** One Turn: its input message, start, `replies` messages, and end. */
function turn(index: number, createdAtMs: number, replies = 1) {
  return [
    message(`input-${index}`, createdAtMs),
    {
      data: {
        type: "turn_started" as const,
        turnId: `turn-${index}`,
        inputMessageIds: [`input-${index}`],
        surface: "internal" as const,
      },
      createdAtMs: createdAtMs + 1,
    },
    ...Array.from({ length: replies }, (_, reply) =>
      message(`reply-${index}-${reply}`, createdAtMs + 2),
    ),
    {
      data: {
        type: "turn_completed" as const,
        turnId: `turn-${index}`,
        outcome: "success" as const,
      },
      createdAtMs: createdAtMs + 3,
    },
  ];
}

/** Read the default detail, then every earlier page through its cursors. */
async function readDefaultDetailAndHistory(conversationId: string) {
  const app = createJuniorApi();
  const response = await app.request(
    `http://localhost/api/conversations/${conversationId}`,
  );
  expect(response.status).toBe(200);
  const detail = conversationDetailReportSchema.parse(await response.json());
  const pages: ConversationReportEvent[][] = [detail.events];
  let before = detail.previousCursor;
  while (before) {
    const pageResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(before)}&limit=7`,
    );
    const page = conversationEventPageSchema.parse(await pageResponse.json());
    pages.unshift(page.events);
    before = page.previousCursor;
  }
  return { detail, history: pages.flat().map((event) => event.seq) };
}

describe("conversation event list API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("pages backward without gaps", async () => {
    const conversationId = "local:test:paged-events";
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
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events.map((event) => event.data.type)).toEqual([
      "message",
      "assistant_message",
      "message",
      "message",
      "subagent",
      "subagent",
    ]);
  });

  it("opens the default detail at the third-latest Turn", async () => {
    const conversationId = "local:test:latest-turns";
    await recordConversation(conversationId);
    await getConversationEventStore().append(
      conversationId,
      Array.from({ length: 5 }, (_, index) => turn(index, index * 10)).flat(),
    );

    const { detail, history } =
      await readDefaultDetailAndHistory(conversationId);
    // Each Turn has 4 events. The page starts with the input message of the
    // third-latest Turn, which comes before its start.
    expect(detail.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => 8 + index),
    );
    expect(detail.events[0]?.data).toMatchObject({
      type: "message",
      messageId: "input-2",
    });
    expect(history).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it("opens the default detail at the start with fewer than three Turns", async () => {
    const conversationId = "local:test:latest-turns-short";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      message("before-turns", 0),
      ...turn(0, 10),
      ...turn(1, 20),
    ]);

    const { detail } = await readDefaultDetailAndHistory(conversationId);
    expect(detail.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 9 }, (_, index) => index),
    );
    expect(detail.previousCursor).toBeUndefined();
  });

  it("caps default pages at 150 events when the latest Turns are longer", async () => {
    const conversationId = "local:test:latest-turns-long";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      ...turn(0, 0),
      ...turn(1, 10),
      ...turn(2, 20, 300),
      ...turn(3, 30, 300),
    ]);

    // The latest three Turns hold 610 events, so the latest 150 are shown.
    const { detail, history } =
      await readDefaultDetailAndHistory(conversationId);
    const seqs = (start: number, length: number) =>
      Array.from({ length }, (_, index) => start + index);
    expect(detail.events.map((event) => event.seq)).toEqual(seqs(464, 150));
    expect(history).toEqual(seqs(0, 614));

    // Event pages without a `limit` hold the same number of events.
    const app = createJuniorApi();
    const readPage = async (query: string) =>
      conversationEventPageSchema.parse(
        await (
          await app.request(
            `http://localhost/api/conversations/${conversationId}/events?${query}`,
          )
        ).json(),
      );
    const earlier = await readPage(
      `before=${encodeURIComponent(detail.previousCursor!)}`,
    );
    expect(earlier.events.map((event) => event.seq)).toEqual(seqs(314, 150));
    // Half of the page ends with the linked event, and the rest follows it.
    const around = await readPage("event=300");
    expect(around.events.map((event) => event.seq)).toEqual(seqs(226, 150));
  });

  it("opens the page around a linked event or Turn", async () => {
    const conversationId = "local:test:linked-events";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      ...Array.from({ length: 10 }, (_, index) =>
        message(`message-${index}`, index + 1),
      ),
      {
        data: {
          type: "turn_started",
          turnId: "turn-linked",
          inputMessageIds: ["message-9"],
          surface: "internal",
        },
        createdAtMs: 11,
      },
      ...Array.from({ length: 10 }, (_, index) =>
        message(`later-${index}`, index + 12),
      ),
    ]);

    const app = createJuniorApi();
    const readPage = async (query: string) => {
      const response = await app.request(
        `http://localhost/api/conversations/${conversationId}/events?${query}&limit=4`,
      );
      expect(response.status).toBe(200);
      return conversationEventPageSchema.parse(await response.json());
    };
    // Half of the page ends with the linked event, and the rest follows it.
    const eventPage = await readPage("event=4");
    expect(eventPage.events.map((event) => event.seq)).toEqual([3, 4, 5, 6]);
    expect(eventPage.previousCursor).toBeDefined();
    expect(eventPage.nextCursor).toBeDefined();
    // A Turn link opens at the event that started the Turn.
    const turnPage = await readPage("turn=turn-linked");
    expect(turnPage.events.map((event) => event.seq)).toEqual([9, 10, 11, 12]);

    const missingTurn = await app.request(
      `http://localhost/api/conversations/${conversationId}/events?turn=turn-missing`,
    );
    expect(missingTurn.status).toBe(404);
    expect(apiErrorSchema.parse(await missingTurn.json())).toEqual({
      error: "Turn not found.",
    });
  });

  it("keeps recorded models and call usage across page boundaries", async () => {
    const conversationId = "local:test:event-model";
    await recordConversation(conversationId);
    const store = getConversationEventStore();
    const initialModel = { modelId: "openai/gpt-5" };
    const nextModel = { modelId: "openai/gpt-5.6-sol" };
    const call = assistantMessage(2, 120);
    call.data.usage.output = 40;
    call.data.usage.cacheRead = 500;
    call.data.usage.cacheWrite = 60;
    call.data.usage.totalTokens = 720;
    await store.append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "turn_started",
          turnId: "turn-1",
          inputMessageIds: ["input-1"],
          surface: "internal",
        },
      },
      {
        ...call,
        data: {
          ...call.data,
          usage: { ...call.data.usage, reasoning: 20 },
          providerMetadata: { secret: "must-not-leak" },
        },
      },
      {
        ...assistantMessage(3),
        data: {
          ...assistantMessage(3).data,
          provider: "vercel-ai-gateway",
          model: nextModel.modelId,
        },
      },
      // More than one scan batch: the latest page must resolve context from SQL.
      ...Array.from({ length: 70 }, (_, index) => ({
        createdAtMs: 4 + index,
        data: {
          type: "tool_execution_started" as const,
          toolCallId: `call-${index}`,
          toolName: "bash",
        },
      })),
    ]);
    const app = createJuniorApi();
    const read = async (limit: number) =>
      conversationDetailReportSchema.parse(
        await (
          await app.request(
            `http://localhost/api/conversations/${conversationId}?limit=${limit}`,
          )
        ).json(),
      );
    const latest = await read(1);
    expect(latest.events[0]?.model).toEqual(nextModel);
    expect(latest.events[0]?.modelCall).toBeUndefined();
    const full = await read(100);
    expect(full.events[1]).toMatchObject({
      model: initialModel,
      modelCall: {
        provider: "openai",
        api: "responses",
        stopReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          cachedInputTokens: 500,
          cacheCreationTokens: 60,
          reasoningTokens: 20,
          totalTokens: 720,
          cost: call.data.usage.cost,
        },
      },
    });
    expect(full.events[2]?.model).toEqual(nextModel);
    expect(full.events[3]?.model).toEqual(nextModel);
    expect(full.events.at(-1)).toEqual(latest.events[0]);
    expect(JSON.stringify(full.events)).not.toContain("must-not-leak");
    if (!latest.previousCursor) throw new Error("Expected a previous cursor");
    const earlier = conversationEventPageSchema.parse(
      await (
        await app.request(
          `http://localhost/api/conversations/${conversationId}/events?before=${encodeURIComponent(latest.previousCursor)}&limit=1`,
        )
      ).json(),
    );
    expect(earlier.events[0]).toEqual(full.events.at(-2));

    await store.append(conversationId, [
      {
        createdAtMs: 80,
        data: { type: "turn_completed", turnId: "turn-1", outcome: "success" },
      },
      message("between-turns", 81),
      {
        createdAtMs: 82,
        data: {
          type: "turn_started",
          turnId: "turn-2",
          inputMessageIds: ["input-2"],
          surface: "internal",
        },
      },
      ...Array.from({ length: 70 }, (_, index) =>
        message(`pending-model-${index}`, 83 + index),
      ),
    ]);
    expect((await read(1)).events[0]?.model).toBeUndefined();
    const finished = await read(100);
    expect(finished.events.find((event) => event.seq === 73)?.model).toEqual(
      nextModel,
    );
    expect(
      finished.events.find((event) => event.seq === 74)?.model,
    ).toBeUndefined();
  });

  it("reports privacy-safe Guardian decisions", async () => {
    const conversationId = "local:test:guardian-events";
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
    const conversationId = "local:test:paged-subagent";
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

  it("finds a subagent start that is more than one scan chunk older", async () => {
    const conversationId = "local:test:paged-subagent-far";
    await recordConversation(conversationId);
    await getConversationEventStore().append(conversationId, [
      {
        data: {
          type: "subagent_started",
          subagentInvocationId: "invocation-far",
          subagentKind: "advisor",
          childConversationId: "child-far",
        },
        createdAtMs: 1,
      },
      // Rows that project to no reporting event, so the scan reads past
      // its first chunk before it finds the start.
      ...Array.from({ length: 70 }, (_, index) => ({
        data: {
          type: "structured_event" as const,
          namespace: "unregistered-plugin",
          name: "progress",
          version: 1,
          content: { index },
        },
        createdAtMs: 2 + index,
      })),
      {
        data: {
          type: "subagent_ended",
          subagentInvocationId: "invocation-far",
          outcome: "success",
        },
        createdAtMs: 100,
      },
    ]);

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}?limit=1`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([
      expect.objectContaining({
        seq: 71,
        data: {
          type: "subagent",
          startedSeq: 0,
          startedAt: "1970-01-01T00:00:00.001Z",
          childConversationId: "child-far",
          subagentKind: "advisor",
          status: "completed",
        },
      }),
    ]);
    expect(detail.previousCursor).toBeDefined();
  });

  it("keeps a terminal tool observation self-contained when its start is older", async () => {
    const conversationId = "local:test:paged-tool";
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
    const firstConversationId = "local:test:first-cursor-owner";
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
    ] as const) {
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
      {
        ...message("private-message-2", 2),
        data: {
          ...message("private-message-2", 2).data,
          meta: {
            cards: [
              {
                kind: "automation",
                id: "secret-task",
                title: "Private automation",
                operation: "created",
                url: "https://junior.example.com/automations/secret-task",
                instruction: "Private instruction",
                trigger: "Private repository",
                warning: null,
              },
            ].flatMap((card) => [card, { ...card, operation: "deleted" }]),
          },
        },
      },
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
    const savedResponse = await participantApi.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    const saved = conversationDetailReportSchema.parse(
      await savedResponse.json(),
    );
    const savedCards = saved.events.find(
      (event) =>
        event.data.type === "message" &&
        event.data.messageId === "private-message-2",
    )?.data;
    expect(savedCards).toMatchObject({
      cards: [{ kind: "object", plugin: "junior", key: "secret-task" }],
    });
    expect(JSON.stringify(savedCards)).not.toContain('"operation"');
    expect(participantDetail.eventHistory.status).toBe("available");
    expect(participantDetail.events[0]?.data).toEqual({
      type: "message",
      messageId: "private-message-3",
      role: "assistant",
      text: "private-message-3",
    });
  });

  it("returns expired history and detail after retention purge", async () => {
    const conversationId = "local:test:expired-paged-events";
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
