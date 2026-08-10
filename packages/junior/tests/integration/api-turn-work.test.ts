import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueApiConversationMessage,
  apiTurnIdForMessage,
  buildApiTurnInboundMessage,
  createAndEnqueueApiConversation,
  createApiConversationId,
  createApiTurnWorker,
  resolveApiTurnWork,
  routeApiTurnWork,
  WebTurnQuotaExceededError,
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
  platform: "web" as const,
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
          message: "Start a dashboard turn.",
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
          message: "Start a dashboard turn.",
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
          message: "Start a dashboard turn.",
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

  it("limits unique web turn enqueues per verified viewer", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();

    try {
      for (let index = 0; index < 20; index += 1) {
        await expect(
          createAndEnqueueApiConversation(
            {
              actor,
              idempotencyKey: `quota-${index}`,
              message: `Dashboard turn ${index}.`,
            },
            { conversationStore, nowMs: 1_000, queue, state },
          ),
        ).resolves.toMatchObject({ status: "accepted" });
      }

      await expect(
        createAndEnqueueApiConversation(
          {
            actor,
            idempotencyKey: "quota-0",
            message: "Dashboard turn 0.",
          },
          { conversationStore, nowMs: 1_000, queue, state },
        ),
      ).resolves.toMatchObject({ status: "duplicate" });

      await expect(
        createAndEnqueueApiConversation(
          {
            actor,
            idempotencyKey: "quota-20",
            message: "Dashboard turn 20.",
          },
          { conversationStore, nowMs: 1_000, queue, state },
        ),
      ).rejects.toBeInstanceOf(WebTurnQuotaExceededError);
      expect(queue.sentRecords()).toHaveLength(20);
    } finally {
      await fixture.close();
    }
  });

  it("enqueues public web turns with publishExternally false and runs them on the worker", async () => {
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
          message: "Start a dashboard turn.",
        },
        { conversationStore, queue, state },
      );
      expect(accepted.status).toBe("accepted");
      expect(accepted.conversationId.startsWith("local:web:")).toBe(true);

      await expect(
        conversationStore.get({ conversationId: accepted.conversationId }),
      ).resolves.toMatchObject({
        source: "web",
        sessionSource: createWebSource(accepted.conversationId),
        visibility: "public",
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
        message: "Start a dashboard turn.",
        messageId: accepted.messageId,
      });
      expect(inbound).toMatchObject({
        publishExternally: false,
        source: "web",
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
                      text: "Start a dashboard turn.",
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
          throw new Error("fallback worker must not run for web turns");
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
      expect(observedSourcePlatform).toBe("web");
      expect(observedActorPlatform).toBe("web");

      const messages = (
        await getConversationEventStore().loadMessageHistory(
          accepted.conversationId,
        )
      ).events.filter((event) => event.data.type === "message");
      expect(messages.map((event) => event.data)).toEqual([
        expect.objectContaining({
          role: "user",
          text: "Start a dashboard turn.",
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
        source: createWebSource(accepted.conversationId),
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

  it("does not claim dispatch resume wakes that share surface api", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const state = getStateAdapter();
    await state.connect();

    try {
      const conversationId = "agent-dispatch:dispatch_shared_surface";
      const turnId = "dispatch:dispatch_shared_surface";
      const destination = {
        platform: "slack" as const,
        teamId: "T123",
        channelId: "C123",
      };
      await saveTurnCheckpoint({
        mode: "paused",
        conversationId,
        turnId,
        sliceId: 1,
        reason: "yield",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Dispatch resume wake." }],
            timestamp: Date.now(),
          },
        ],
        destination,
        publishExternally: true,
        dispatchId: "dispatch_shared_surface",
        surface: "api",
      });

      const resolved = await resolveApiTurnWork({
        attempt: {
          ack: async () => undefined,
          conversationId,
          destination,
          drain: async () => [],
          isFinalAttempt: false,
          messages: [],
        },
        conversationId,
        destination,
        publishExternally: true,
        shouldYield: () => false,
        checkIn: async () => true,
      });
      expect(resolved).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
