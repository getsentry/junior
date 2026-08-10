import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiSource } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueApiConversationMessage,
  apiTurnIdForMessage,
  buildApiTurnInboundMessage,
  createAndEnqueueApiConversation,
  createApiConversationId,
  createApiTurnWorker,
  resolveApiTurnWork,
  routeApiTurnWork,
} from "@/chat/api-turns/work";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getConversationEventStore } from "@/chat/db";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const actor = {
  platform: "api" as const,
  userId: "dashboard:alice",
  email: "alice@example.com",
  fullName: "Alice Example",
  userName: "alice",
};

describe("api turn conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("derives a durable create id and returns the same conversation on retry", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();

    try {
      const expectedConversationId = createApiConversationId({
        actorEmail: actor.email,
        idempotencyKey: "create-1",
      });
      const accepted = await createAndEnqueueApiConversation(
        {
          actor,
          idempotencyKey: "create-1",
          message: "Start a private dashboard turn.",
        },
        { conversationStore, queue, state },
      );
      expect(accepted).toMatchObject({
        conversationId: expectedConversationId,
        status: "accepted",
      });

      const createRetry = await createAndEnqueueApiConversation(
        {
          actor,
          idempotencyKey: "create-1",
          message: "Start a private dashboard turn.",
        },
        { conversationStore, queue, state },
      );
      expect(createRetry).toMatchObject({
        conversationId: accepted.conversationId,
        messageId: accepted.messageId,
        status: "duplicate",
      });

      const appendDuplicate = await appendAndEnqueueApiConversationMessage(
        {
          actor,
          conversationId: accepted.conversationId,
          idempotencyKey: "create-1",
          message: "Start a private dashboard turn.",
        },
        { conversationStore, queue, state },
      );
      expect(appendDuplicate).toMatchObject({
        conversationId: accepted.conversationId,
        messageId: accepted.messageId,
        status: "duplicate",
      });
    } finally {
      await fixture.close();
    }
  });

  it("enqueues private API turns with publishExternally false and runs them on the worker", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();

    try {
      const accepted = await createAndEnqueueApiConversation(
        {
          actor,
          idempotencyKey: "create-1",
          message: "Start a private dashboard turn.",
        },
        { conversationStore, queue, state },
      );
      expect(accepted.status).toBe("accepted");
      expect(accepted.conversationId.startsWith("local:api:")).toBe(true);

      await expect(
        conversationStore.get({ conversationId: accepted.conversationId }),
      ).resolves.toMatchObject({
        source: "api",
        sessionSource: createApiSource(accepted.conversationId),
        visibility: "private",
        destination: {
          platform: "local",
          conversationId: accepted.conversationId,
        },
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
      });

      const inbound = buildApiTurnInboundMessage({
        actor,
        conversationId: accepted.conversationId,
        message: "Start a private dashboard turn.",
        messageId: accepted.messageId,
      });
      expect(inbound).toMatchObject({
        publishExternally: false,
        source: "api",
      });

      let observedPublishExternally: boolean | undefined;
      let observedSourcePlatform: string | undefined;
      let observedActorPlatform: string | undefined;
      const worker = createApiTurnWorker({
        agentRunner: {
          run: async (request) => {
            observedPublishExternally = request.routing.publishExternally;
            observedSourcePlatform = request.routing.source.platform;
            observedActorPlatform = request.routing.actor?.platform;
            const reply = {
              role: "assistant" as const,
              content: [
                { type: "text" as const, text: "Stored only in Junior." },
              ],
              api: "openai-responses",
              provider: "openai",
              model: "fake-api-turn",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            };
            await request.delivery?.(reply);
            return completedAgentRun({
              text: "Stored only in Junior.",
              piMessages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Start a private dashboard turn.",
                    },
                  ],
                  timestamp: Date.now(),
                },
                reply,
              ],
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-api-turn",
                outcome: "success",
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            });
          },
        },
      });
      const route = routeApiTurnWork({
        apiTurnWorker: worker,
        fallbackWorker: async () => {
          throw new Error("fallback worker must not run for API turns");
        },
      });

      await expect(
        processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });

      expect(observedPublishExternally).toBe(false);
      expect(observedSourcePlatform).toBe("api");
      expect(observedActorPlatform).toBe("api");

      const messages = (
        await getConversationEventStore().loadMessageHistory(
          accepted.conversationId,
        )
      ).events.filter((event) => event.data.type === "message");
      expect(messages.map((event) => event.data)).toEqual([
        expect.objectContaining({
          role: "user",
          text: "Start a private dashboard turn.",
        }),
        expect.objectContaining({
          role: "assistant",
          text: "Stored only in Junior.",
        }),
      ]);

      await expect(
        getTurnRecord(
          accepted.conversationId,
          apiTurnIdForMessage(accepted.messageId),
        ),
      ).resolves.toMatchObject({
        publishExternally: false,
        state: "completed",
        surface: "api",
      });
    } finally {
      await fixture.close();
    }
  });

  it("routes empty resume wakes to the active API turn", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();

    try {
      const accepted = await createAndEnqueueApiConversation(
        {
          actor,
          idempotencyKey: "resume-1",
          message: "Resume after yield.",
        },
        { conversationStore, queue, state },
      );
      const turnId = apiTurnIdForMessage(accepted.messageId);
      const destination = {
        platform: "local" as const,
        conversationId: accepted.conversationId,
      };
      await saveTurnCheckpoint({
        mode: "paused",
        conversationId: accepted.conversationId,
        turnId,
        sliceId: 1,
        reason: "yield",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Resume after yield." }],
            timestamp: Date.now(),
          },
        ],
        destination,
        publishExternally: false,
        source: createApiSource(accepted.conversationId),
        actor,
        surface: "api",
      });

      const resolved = await resolveApiTurnWork({
        attempt: {
          ack: async () => undefined,
          conversationId: accepted.conversationId,
          destination,
          drain: async () => [],
          isFinalAttempt: false,
          messages: [],
        },
        conversationId: accepted.conversationId,
        destination,
        publishExternally: false,
        shouldYield: () => false,
        checkIn: async () => true,
      });
      expect(resolved).toEqual({ kind: "resume", turnId });
    } finally {
      await fixture.close();
    }
  });
});
