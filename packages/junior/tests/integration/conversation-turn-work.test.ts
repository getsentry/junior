import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResourceEventSource,
  createSlackSource,
  createWebSource,
} from "@sentry/junior-plugin-api";
import {
  appendAndEnqueueWebMessage,
  buildWebInboundMessage,
  conversationTurnIdForMessage,
  createAndEnqueueConversation,
  createConversationId,
  recordWebConversationActivity,
} from "@/chat/conversations/web-input";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import {
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import type { AgentRun } from "@/chat/agent/types";
import { getConversationEventStore } from "@/chat/db";
import { RESOURCE_EVENT_SYSTEM_ACTOR } from "@/chat/resource-events/actor";
import { createResourceEventInboundMessage } from "@/chat/resource-events/notification";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import {
  closeConversationFixture,
  createConversationFixture,
  emptyConversationTurnAttempt,
} from "../fixtures/conversation";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";

function requireConversationTurn(
  worker: (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>,
) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveMailboxTurnWork(context);
    if (!resolved) {
      throw new Error("Expected Conversation mailbox work");
    }
    return await worker(context, resolved);
  };
}

describe("Conversation mailbox Turn work", () => {
  afterEach(async () => {
    await closeConversationFixture();
    vi.restoreAllMocks();
  });

  it("derives a durable create id and returns the same conversation on retry", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const expectedConversationId = createConversationId({
      actorEmail: actor.email,
      idempotencyKey: "create-1",
    });
    const accepted = await createAndEnqueueConversation(
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

    const createRetry = await createAndEnqueueConversation(
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

    const appendDuplicate = await appendAndEnqueueWebMessage(
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

  it("runs a public web Message with public Source visibility", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
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

    const inbound = buildWebInboundMessage({
      actor,
      conversationId: accepted.conversationId,
      message: "Start a dashboard turn.",
      messageId: accepted.messageId,
    });
    expect(inbound).toMatchObject({
      source: "web",
    });

    const agentRuns: AgentRun[] = [];
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Stored only in Junior." },
        ]);
      }),
    );
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
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
        conversationTurnIdForMessage(accepted.messageId),
      ),
    ).resolves.toMatchObject({
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
          turnId: conversationTurnIdForMessage(accepted.messageId),
          type: "turn_started",
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "success",
          turnId: conversationTurnIdForMessage(accepted.messageId),
          type: "turn_completed",
        }),
      }),
    ]);
  });

  it("feeds private source visibility into the agent run", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
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
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Private reply stays in Junior." },
        ]);
      }),
    );
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.source).toEqual(
      createWebSource(accepted.conversationId, "private"),
    );
  });

  it("reports a lost lease when cancelled input acknowledgement fails", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
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
    const inbound = buildWebInboundMessage({
      actor,
      conversationId: accepted.conversationId,
      destination,
      message: "Cancel before this Turn starts.",
      messageId: accepted.messageId,
    });
    const stop = new AbortController();
    stop.abort(new DOMException("Turn cancelled", "AbortError"));
    const agentRuns: AgentRun[] = [];
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Cancelled Turn must not reach the agent." },
        ]);
      }),
    );
    const run = requireConversationTurn(worker);

    await expect(
      run({
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
        shouldYield: () => false,
        stopSignal: () => stop.signal,
      }),
    ).resolves.toEqual({ status: "lost_lease" });
    expect(agentRuns).toHaveLength(0);
  });

  it("routes an empty resume wake to the active Turn", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "resume-1",
        message: "Resume after yield.",
      },
      { conversationStore, queue, state },
    );
    const turnId = conversationTurnIdForMessage(accepted.messageId);
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
      source: createWebSource(accepted.conversationId),
      actor,
      surface: "api",
    });

    const resolved = await resolveMailboxTurnWork({
      attempt: emptyConversationTurnAttempt({
        conversationId: accepted.conversationId,
        destination,
      }),
      conversationId: accepted.conversationId,
      destination,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toEqual({ kind: "resume", turnId });
  });

  it("resumes a paused dashboard Turn before a deferred resource event", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const accepted = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "dashboard-before-resource-event",
        message: "Check the current state.",
      },
      { conversationStore, queue, state },
    );
    const dashboardTurnId = conversationTurnIdForMessage(accepted.messageId);
    const resourceMessage = createResourceEventInboundMessage({
      event: {
        eventKey: "checks-failed-after-dashboard-yield",
        eventType: "pull_request.checks.failed",
        identifier: "getsentry/junior#1563",
        namespace: "github",
        occurredAtMs: 2,
        trustedSummary: "Code change checks failed",
      },
      receivedAtMs: 2,
      subscription: {
        conversationId: accepted.conversationId,
        id: "resource-subscription-after-dashboard-yield",
      },
      text: "Code change checks failed",
    });
    const resourceTurnId = conversationTurnIdForMessage(
      resourceMessage.inboundMessageId,
    );
    const agentRuns: AgentRun[] = [];
    let dashboardStarted = false;
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        if (run.turnId === dashboardTurnId && !dashboardStarted) {
          dashboardStarted = true;
          return createModelStream([
            { type: "toolCall", name: "systemTime", arguments: {} },
            { type: "text", text: "Dashboard Turn finished." },
          ]);
        }
        return createModelStream([
          {
            type: "text",
            text:
              run.turnId === dashboardTurnId
                ? "Dashboard Turn finished."
                : "Resource event handled.",
          },
        ]);
      }),
    );
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        softYieldAfterMs: 0,
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });
    await expect(
      getTurnRecord(accepted.conversationId, dashboardTurnId),
    ).resolves.toMatchObject({
      resumeReason: "yield",
      state: "paused",
    });

    await appendAndEnqueueInboundMessage({
      conversationStore,
      message: resourceMessage,
      queue,
      state,
    });
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(agentRuns.map((run) => run.turnId)).toEqual([
      dashboardTurnId,
      dashboardTurnId,
      resourceTurnId,
    ]);
    await expect(
      getTurnRecord(accepted.conversationId, dashboardTurnId),
    ).resolves.toMatchObject({ state: "completed" });
    await expect(
      getTurnRecord(accepted.conversationId, resourceTurnId),
    ).resolves.toMatchObject({ state: "completed" });
  }, 10_000);

  it("runs and resumes a resource event with a local Destination", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = createConversationId({
      actorEmail: actor.email,
      idempotencyKey: "resource-event-root-1",
    });
    const destination = await recordWebConversationActivity({
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
    const turnId = conversationTurnIdForMessage(messageId);
    const source = createResourceEventSource({
      eventKey: "checks-failed-1",
      eventType: "check_suite.completed",
      identifier: "getsentry/junior#1563",
      namespace: "github",
    });
    const agentRuns: AgentRun[] = [];
    let firstRun = true;
    const worker = createConversationTurnWorker(
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
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        nowMs: () => 10,
        queue,
        run,
        softYieldAfterMs: 0,
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      actor: RESOURCE_EVENT_SYSTEM_ACTOR,
      resumeReason: "yield",
      source,
      state: "paused",
    });

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        nowMs: () => 20,
        queue,
        run,
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
          source,
          turnId,
        }),
      );
      expect(run.authorization).toBeUndefined();
    }
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      actor: RESOURCE_EVENT_SYSTEM_ACTOR,
      source,
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

  it("delivers a resumed resource event from the Conversation Location", async () => {
    const { conversationStore, queue, state } =
      await createConversationFixture();
    const conversationId = "slack:C123";
    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    await conversationStore.recordActivity({
      conversationId,
      destination,
      nowMs: 1,
      source: "slack",
    });
    const message = createResourceEventInboundMessage({
      event: {
        eventKey: "legacy-review-requested-1",
        eventType: "pull_request.review.requested",
        identifier: "getsentry/junior#1563",
        namespace: "github",
        occurredAtMs: 2,
        trustedSummary: "Code change review requested",
      },
      receivedAtMs: 2,
      subscription: {
        conversationId,
        id: "legacy-resource-subscription-1",
      },
      text: "Code change review requested",
    });
    await appendAndEnqueueInboundMessage({
      conversationStore,
      message,
      queue,
      state,
    });

    const turnId = conversationTurnIdForMessage(message.inboundMessageId);
    const source = createResourceEventSource({
      eventKey: "legacy-review-requested-1",
      eventType: "pull_request.review.requested",
      identifier: "getsentry/junior#1563",
      namespace: "github",
    });
    const agentRuns: AgentRun[] = [];
    let firstRun = true;
    const deliverMessage = vi.fn(async () => ({
      providerMessageId: "1712346.0001",
    }));
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        if (firstRun) {
          firstRun = false;
          return createModelStream([
            { type: "toolCall", name: "systemTime", arguments: {} },
            { type: "text", text: "Review request handled." },
          ]);
        }
        return createModelStream([
          { type: "text", text: "Review request handled." },
        ]);
      }),
      deliverMessage,
    );
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        softYieldAfterMs: 0,
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });
    const pausedTurn = await getTurnRecord(conversationId, turnId);
    expect(pausedTurn).toMatchObject({
      source,
      state: "paused",
    });
    expect(pausedTurn).not.toHaveProperty("publishExternally");

    const storedCursor = await state.get(turnCursorKey(conversationId, turnId));
    if (!storedCursor || typeof storedCursor !== "object") {
      throw new Error("Expected stored Turn cursor");
    }
    const {
      publishExternally: storedPublish,
      source: storedSource,
      ...legacyCursor
    } = storedCursor as Record<string, unknown>;
    expect(storedPublish).toBe(true);
    expect(storedSource).toEqual(source);
    await state.set(
      turnCursorKey(conversationId, turnId),
      legacyCursor,
      60_000,
    );

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(agentRuns).toHaveLength(2);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        source,
      }),
    );
    expect(agentRuns[1]).toEqual(
      expect.objectContaining({
        source: createWebSource(conversationId),
      }),
    );
    expect(deliverMessage).toHaveBeenCalledOnce();
  }, 10_000);

  it("does not claim dispatch resume wakes that share surface api", async () => {
    await createConversationFixture();
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
      dispatchId: "dispatch_shared_surface",
      surface: "api",
    });

    const resolved = await resolveMailboxTurnWork({
      attempt: emptyConversationTurnAttempt({ conversationId, destination }),
      conversationId,
      destination,
      shouldYield: () => false,
      checkIn: async () => true,
    });
    expect(resolved).toBeUndefined();
  });

  it("keeps dashboard input in Junior without abandoning a Slack auth pause", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
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
        kind: "slack",
        visibility: "public",
        teamId: "T1200",
        channelId: "C1200",
        threadTs: "1712345.1200",
      },
      visibility: "public",
    });
    const slackAuthTurnId = "turn-slack-auth";
    await saveTurnCheckpoint({
      mode: "paused",
      conversationId,
      turnId: slackAuthTurnId,
      sliceId: 1,
      reason: "auth",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Slack Turn waiting for auth." }],
          timestamp: 1,
        },
      ],
      destination: slackDestination,
      source: createSlackSource({
        channelId: "C1200",
        teamId: "T1200",
        threadTs: "1712345.1200",
        visibility: "public",
      }),
      surface: "slack",
    });

    const accepted = await appendAndEnqueueWebMessage(
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
        kind: "slack",
        teamId: "T1200",
        channelId: "C1200",
        threadTs: "1712345.1200",
      },
    });

    const inbound = buildWebInboundMessage({
      actor,
      conversationId,
      destination: slackDestination,
      message: "Continue from the dashboard.",
      messageId: accepted.messageId,
    });
    expect(inbound).toMatchObject({
      destination: slackDestination,
      source: "web",
    });

    const agentRuns: AgentRun[] = [];
    const deliverMessage = vi.fn(async () => ({}));
    const worker = createConversationTurnWorker(
      createModelAgentRunnerForRun((run) => {
        agentRuns.push(run);
        return createModelStream([
          { type: "text", text: "Dashboard-only reply." },
        ]);
      }),
      deliverMessage,
    );
    const run = requireConversationTurn(worker);

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        conversationStore,
        queue,
        run,
        state,
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toEqual(
      expect.objectContaining({
        destination: expect.objectContaining({ platform: "slack" }),
        location: storedConversation?.location,
        source: expect.objectContaining({ kind: "web" }),
      }),
    );
    expect(deliverMessage).not.toHaveBeenCalled();

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
      getTurnRecord(
        conversationId,
        conversationTurnIdForMessage(accepted.messageId),
      ),
    ).resolves.toMatchObject({
      state: "completed",
      surface: "api",
    });
    await expect(
      getTurnRecord(conversationId, slackAuthTurnId),
    ).resolves.toMatchObject({
      resumeReason: "auth",
      state: "paused",
      surface: "slack",
    });
  });
});
