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
} from "@/chat/api-turns/work";
import { getConversationEventStore } from "@/chat/db";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  closeApiTurnWorkFixture,
  createApiTurnScriptedRunner,
  createApiTurnWorkFixture,
  emptyApiTurnAttempt,
} from "../fixtures/api-turn";

describe("api turn conversation work", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
    vi.restoreAllMocks();
  });

  it("derives a durable create id and returns the same conversation on retry", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
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
  });

  it("enqueues public web turns with publishExternally false and runs them on the worker", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
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
      agentRunner: createApiTurnScriptedRunner({
        replyText: "Stored only in Junior.",
        onRun: (request) => {
          observedPublishExternally = request.routing.publishExternally;
          observedSourcePlatform = request.routing.source.platform;
          observedActorPlatform = request.routing.actor?.platform;
        },
      }),
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
  });

  it("routes empty resume wakes to the active API turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
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
      attempt: emptyApiTurnAttempt({
        conversationId: accepted.conversationId,
        destination,
      }),
      conversationId: accepted.conversationId,
      destination,
      publishExternally: false,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toEqual({ kind: "resume", turnId });
  });

  it("does not claim dispatch resume wakes that share surface api", async () => {
    await createApiTurnWorkFixture();
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
      attempt: emptyApiTurnAttempt({ conversationId, destination }),
      conversationId,
      destination,
      publishExternally: true,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toBeUndefined();
  });
});
