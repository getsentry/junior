import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource, createWebSource } from "@sentry/junior-plugin-api";
import { createApiTurnCancellation } from "@/chat/api-turns/cancellation";
import {
  appendAndEnqueueApiConversationMessage,
  apiTurnIdForMessage,
  buildApiTurnInboundMessage,
  createAndEnqueueApiConversation,
  createApiConversationId,
  createMailboxTurnWorker,
  recordApiConversationActivity,
  resolveMailboxTurnWork,
  routeMailboxTurnWork,
} from "@/chat/api-turns/work";
import type { AgentRun } from "@/chat/agent/types";
import { getConversationEventStore } from "@/chat/db";
import { RESOURCE_EVENT_SYSTEM_ACTOR } from "@/chat/resource-events/actor";
import { createResourceEventInboundMessage } from "@/chat/resource-events/notification";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  closeApiTurnWorkFixture,
  createApiTurnWorkFixture,
  emptyApiTurnAttempt,
} from "../fixtures/api-turn";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

describe("Conversation API work", () => {
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
        visibility: "private",
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
        visibility: "public",
      },
      { conversationStore, queue, state },
    );
    expect(createRetry).toMatchObject({
      conversationId: accepted.conversationId,
      messageId: accepted.messageId,
      status: "duplicate",
    });
    await expect(
      conversationStore.get({ conversationId: accepted.conversationId }),
    ).resolves.toMatchObject({
      sessionSource: createWebSource(accepted.conversationId, "private"),
      visibility: "private",
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

  it("runs a public Conversation API message with public source visibility", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "create-public-1",
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
      sessionSource: createWebSource(accepted.conversationId, "public"),
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

    const agentRuns: AgentRun[] = [];
    const worker = createMailboxTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Stored only in Junior." },
        ]);
      }),
    );
    const route = routeMailboxTurnWork({
      mailboxTurnWorker: worker,
      fallbackWorker: async () => {
        throw new Error(
          "fallback worker must not run for Conversation API work",
        );
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

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        publishExternally: false,
        source: createWebSource(accepted.conversationId, "public"),
        actor: expect.objectContaining({ platform: "web" }),
      }),
    );

    // Title generation is automatic on human transcript persist and may finish
    // just after the worker returns completed.
    await vi.waitFor(async () => {
      const stored = await conversationStore.get({
        conversationId: accepted.conversationId,
      });
      expect(stored?.title?.trim().length).toBeGreaterThan(0);
    });

    const history = await getConversationEventStore().loadHistory(
      accepted.conversationId,
    );
    const messages = history.filter((event) => event.data.type === "message");
    expect(messages.map((event) => event.data)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Start a dashboard turn.",
        meta: expect.objectContaining({ source: "web" }),
      }),
      expect.objectContaining({
        role: "assistant",
        text: "Stored only in Junior.",
        meta: expect.objectContaining({ source: "web" }),
      }),
    ]);
    const agentReply = history.findIndex(
      (event) => event.data.type === "assistant_message",
    );
    const deliveredReply = history.findIndex(
      (event) =>
        event.data.type === "message" && event.data.role === "assistant",
    );
    expect(agentReply).toBeGreaterThanOrEqual(0);
    expect(deliveredReply).toBeGreaterThan(agentReply);

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

    const turnEvents = (
      await getConversationEventStore().loadHistory(accepted.conversationId)
    ).filter(
      (event) =>
        event.data.type === "turn_started" ||
        event.data.type === "turn_completed" ||
        event.data.type === "turn_failed",
    );
    expect(turnEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          surface: "api",
          turnId: apiTurnIdForMessage(accepted.messageId),
          type: "turn_started",
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "success",
          turnId: apiTurnIdForMessage(accepted.messageId),
          type: "turn_completed",
        }),
      }),
    ]);
  });

  it("feeds private source visibility into the agent run", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "create-private-1",
        message: "Start a private dashboard turn.",
        visibility: "private",
      },
      { conversationStore, queue, state },
    );

    await expect(
      conversationStore.get({ conversationId: accepted.conversationId }),
    ).resolves.toMatchObject({
      sessionSource: createWebSource(accepted.conversationId, "private"),
      visibility: "private",
    });

    const agentRuns: AgentRun[] = [];
    const worker = createMailboxTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Private reply stays in Junior." },
        ]);
      }),
    );
    const route = routeMailboxTurnWork({
      mailboxTurnWorker: worker,
      fallbackWorker: async () => {
        throw new Error(
          "fallback worker must not run for Conversation API work",
        );
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
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.source).toEqual(
      createWebSource(accepted.conversationId, "private"),
    );
  });

  it("reports a lost lease and releases cancellation when ack fails", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "cancel-lost-lease-1",
        message: "Cancel before this Turn starts.",
      },
      { conversationStore, queue, state },
    );
    const destination = {
      platform: "local" as const,
      conversationId: accepted.conversationId,
    };
    const inbound = buildApiTurnInboundMessage({
      actor,
      conversationId: accepted.conversationId,
      destination,
      message: "Cancel before this Turn starts.",
      messageId: accepted.messageId,
    });
    const cancellation = createApiTurnCancellation();
    const signal = cancellation.begin(accepted.conversationId);
    if (!signal) throw new Error("Expected an active Turn signal");
    cancellation.cancel(accepted.conversationId);
    const agentRuns: AgentRun[] = [];
    const worker = createMailboxTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Cancelled Turn must not reach the agent." },
        ]);
      }),
      cancellation,
    );
    const route = routeMailboxTurnWork({
      mailboxTurnWorker: worker,
      fallbackWorker: async () => {
        throw new Error("Fallback worker must not run for API Turn work");
      },
    });

    await expect(
      route({
        attempt: {
          ack: async () => {
            throw new Error("lease lost");
          },
          conversationId: accepted.conversationId,
          destination,
          drain: async () => [],
          isFinalAttempt: false,
          messages: [inbound],
        },
        checkIn: async () => true,
        conversationId: accepted.conversationId,
        destination,
        publishExternally: false,
        shouldYield: () => false,
      }),
    ).resolves.toEqual({ status: "lost_lease" });
    expect(agentRuns).toHaveLength(0);
    expect(cancellation.begin(accepted.conversationId)).toBeDefined();
  });

  it("routes an empty resume wake to the active Turn", async () => {
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

    const resolved = await resolveMailboxTurnWork({
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

  it("runs and resumes a resource event with a local Destination", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const conversationId = createApiConversationId({
      actorEmail: actor.email,
      idempotencyKey: "resource-event-root-1",
    });
    const destination = await recordApiConversationActivity({
      actor,
      conversationId,
      conversationStore,
      nowMs: 1,
    });
    await conversationStore.recordActivity({
      activityAtMs: 1,
      conversationId,
      nowMs: 1,
      title: "Resource events",
    });
    const message = createResourceEventInboundMessage({
      event: {
        eventKey: "checks-failed-1",
        eventType: "check_suite.completed",
        identifier: "getsentry/junior#1563",
        namespace: "github",
        occurredAtMs: 2,
        trustedSummary: "Code change checks failed",
      },
      receivedAtMs: 2,
      subscription: {
        conversationId,
        id: "resource-subscription-1",
      },
      text: "Code change checks failed",
    });
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message,
      queue,
      state,
    });

    const messageId = message.inboundMessageId;
    const turnId = apiTurnIdForMessage(messageId);
    const agentRuns: AgentRun[] = [];
    let firstRun = true;
    const worker = createMailboxTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        if (firstRun) {
          firstRun = false;
          return createModelStream([
            { type: "toolCall", name: "systemTime", arguments: {} },
            { type: "text", text: "Handled the resource event." },
          ]);
        }
        return createModelStream([
          { type: "text", text: "Handled the resource event." },
        ]);
      }),
    );
    const route = routeMailboxTurnWork({
      mailboxTurnWorker: worker,
      fallbackWorker: async () => {
        throw new Error("Provider must not receive this resource event");
      },
    });

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        nowMs: () => 10,
        queue,
        run: route,
        softYieldAfterMs: 0,
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      publishExternally: false,
      resumeReason: "yield",
      state: "paused",
    });

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        nowMs: () => 20,
        queue,
        run: route,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(agentRuns).toHaveLength(2);
    for (const run of agentRuns) {
      expect(run).toEqual(
        expect.objectContaining({
          actor: RESOURCE_EVENT_SYSTEM_ACTOR,
          credentialContext: { actor: RESOURCE_EVENT_SYSTEM_ACTOR },
          destination,
          disabledFeatures: ["interactive-auth"],
          publishExternally: false,
          source: createLocalSource(conversationId),
          turnId,
        }),
      );
      expect(run.authorization).toBeUndefined();
    }
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      publishExternally: false,
      state: "completed",
    });
    const transcript = (
      await getConversationEventStore().loadHistory(conversationId)
    ).flatMap((event) =>
      event.data.type === "message"
        ? [
            {
              role: event.data.role,
              source: event.data.meta?.source,
              text: event.data.text,
            },
          ]
        : [],
    );
    expect(transcript).toEqual([
      {
        role: "user",
        source: undefined,
        text: "Code change checks failed",
      },
      {
        role: "assistant",
        source: undefined,
        text: "Handled the resource event.",
      },
    ]);
  }, 10_000);

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

    const resolved = await resolveMailboxTurnWork({
      attempt: emptyApiTurnAttempt({ conversationId, destination }),
      conversationId,
      destination,
      publishExternally: true,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toBeUndefined();
  });

  it("continues a Slack-rooted conversation without publishing externally", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const conversationId = "slack:C1200:1712345.1200";
    const slackDestination = {
      platform: "slack" as const,
      teamId: "T1200",
      channelId: "C1200",
    };
    await conversationStore.recordActivity({
      conversationId,
      destination: slackDestination,
      nowMs: 1,
      actor: {
        platform: "slack",
        email: actor.email,
        fullName: actor.fullName,
        slackUserId: "U1200",
        teamId: "T1200",
      },
      source: "slack",
      sessionSource: {
        platform: "slack",
        visibility: "public",
        teamId: "T1200",
        channelId: "C1200",
        threadTs: "1712345.1200",
      },
      visibility: "public",
    });

    const accepted = await appendAndEnqueueApiConversationMessage(
      {
        actor,
        conversationId,
        idempotencyKey: "slack-continue-1",
        message: "Continue from the dashboard.",
      },
      { conversationStore, queue, state },
    );
    expect(accepted).toMatchObject({
      conversationId,
      status: "accepted",
    });

    const storedConversation = await conversationStore.get({ conversationId });
    expect(storedConversation).toMatchObject({
      source: "slack",
      destination: slackDestination,
      location: {
        provider: "slack",
        teamId: "T1200",
        channelId: "C1200",
        threadTs: "1712345.1200",
      },
      visibility: "public",
      sessionSource: {
        platform: "slack",
        teamId: "T1200",
        channelId: "C1200",
        threadTs: "1712345.1200",
      },
    });

    const inbound = buildApiTurnInboundMessage({
      actor,
      conversationId,
      destination: slackDestination,
      message: "Continue from the dashboard.",
      messageId: accepted.messageId,
    });
    expect(inbound).toMatchObject({
      destination: slackDestination,
      publishExternally: false,
      source: "web",
    });

    const agentRuns: AgentRun[] = [];
    const worker = createMailboxTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Dashboard-only reply." },
        ]);
      }),
    );
    const route = routeMailboxTurnWork({
      mailboxTurnWorker: worker,
      fallbackWorker: async () => {
        throw new Error("fallback worker must not run for web continues");
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

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        destination: expect.objectContaining({ platform: "slack" }),
        location: storedConversation?.location,
        publishExternally: false,
        source: expect.objectContaining({ platform: "web" }),
      }),
    );

    const messages = (
      await getConversationEventStore().loadMessageHistory(conversationId)
    ).events.filter((event) => event.data.type === "message");
    expect(messages.map((event) => event.data)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Continue from the dashboard.",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "Dashboard-only reply.",
      }),
    ]);

    await expect(
      getTurnRecord(conversationId, apiTurnIdForMessage(accepted.messageId)),
    ).resolves.toMatchObject({
      publishExternally: false,
      state: "completed",
      surface: "api",
    });
  });
});
