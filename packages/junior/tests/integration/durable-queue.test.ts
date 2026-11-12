import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { SLACK_STOP_ACK } from "@/chat/ingress/slack-stop";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import {
  FUNCTION_TIMEOUT_BUFFER_SECONDS,
  botConfig,
  getChatConfig,
} from "@/chat/config";
import {
  commitAcceptedReply,
  loadProjection,
} from "@/chat/conversations/projection";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import type { PiMessage } from "@/chat/pi/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationStore } from "@/chat/db";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_LEASE_TTL_MS,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  LOST_WORKER_RESUME_MESSAGE,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  SLACK_BOT_USER_ID,
  createSlackAdapterFixture,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../fixtures/conversation-work";
import {
  expectAnotherPersonsTurn,
  expectAssistantInSql,
  expectNextTurn,
  expectTerminalTurn,
  expireDeadWorkerLease,
  expireLiveWorkerLease,
} from "../fixtures/durable-queue";
import {
  chatPostMessageOk,
  conversationsRepliesPage,
} from "../fixtures/slack/factories/api";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import { createModelStream } from "../fixtures/model-stream";
import { createModelAgentRunner } from "../fixtures/agent-runner";
import { createEventInboundMessage } from "@/chat/events/notification";
import { conversationTurnIdForMessage } from "@/chat/conversations/web-input";

/**
 * Turn-lifecycle product outcomes for one conversation under the durable queue.
 * See https://github.com/getsentry/junior/issues/1398
 *
 * Drive live Slack ingress → worker → real agent. Fake only the model stream and
 * Slack HTTP. Assert user-visible replies, turn terminal state, SQL history, and
 * that a later mention still works.
 */

/** Host request budget the worker and agent share in production. */
function requestBudgetMs(): number {
  return (
    (getChatConfig().functionMaxDurationSeconds -
      FUNCTION_TIMEOUT_BUFFER_SECONDS) *
    1000
  );
}

/** `requestStartedAtMs` so only `remainingMs` is left on the host deadline. */
function almostSpentStartedAtMs(remainingMs: number): number {
  return Date.now() - requestBudgetMs() + remainingMs;
}

/**
 * Compose the same ingress, runtime, worker, resume, SQL, and delivery path used
 * in production. These tests must not replace Junior-owned runtime behavior.
 * They may fake only model generation at the agent stream boundary and Slack
 * I/O at the adapter boundary.
 */
async function slack(options: { modelStream?: StreamFn } = {}) {
  const state = getStateAdapter();
  await state.connect();
  const wakes = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  const modelStream =
    options.modelStream ??
    createModelStream([{ type: "text", text: "Deploy checked." }]);
  const agentRunner = createModelAgentRunner(modelStream);
  const work = createConversationWork({
    agentRunner,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
    queue: wakes,
    services: { agentRunner },
    state,
  });
  return {
    state,
    wakes,
    replies: () =>
      slackApiOutbox
        .messages()
        .map((call) => call.params.text)
        .filter((text): text is string => typeof text === "string"),
    next: async (requestStartedAtMs?: number) => {
      // Use production worker shouldYield (lease + host request deadline).
      const process = async () =>
        await processConversationQueueMessage(wakes.takeMessage(), {
          queue: wakes,
          run: work.run,
          state,
        });
      return requestStartedAtMs === undefined
        ? await process()
        : await runWithTurnRequestDeadline(process, requestStartedAtMs);
    },
    send: async (
      input: {
        eventType?: "app_mention" | "message";
        text?: string;
        threadTs?: string;
        ts?: string;
        user?: string;
      } = {},
    ) =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            text: `<@${SLACK_BOT_USER_ID}> inspect the deploy`,
            ...input,
          }),
        ),
        services: {
          getSlackAdapter: () => adapter,
          queue: wakes,
          runtime: work.runtime,
          state,
        },
      }),
  };
}

/**
 * Seed only the residue a dead prior worker leaves behind. Product paths that
 * the live ingress can create must not use this helper.
 */
async function seedDeadWorkerResidue(
  mode: "paused" | "running",
  options: {
    errorMessage?: string;
    lostWorkerResumeCount?: number;
    reason?: "retry" | "timeout";
    sliceId?: number;
  } = {},
) {
  const { reason = "timeout", ...overrides } = options;
  const turnId = "turn_1712345_0001";
  const assistant = fauxAssistantMessage("checking");
  assistant.timestamp = 2;
  assistant.content.push({
    type: "toolCall",
    id: "call-1",
    name: "systemTime",
    arguments: {},
  });
  const messages: PiMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "inspect the deploy" }],
      timestamp: 1,
    },
    assistant,
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "systemTime",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const checkpoint = {
    conversationId: CONVERSATION_ID,
    turnId,
    sliceId: 1,
    modelId: "test-model",
    messages,
    destination: SLACK_DESTINATION,
    source: createSlackSource({
      teamId: SLACK_DESTINATION.teamId,
      channelId: SLACK_DESTINATION.channelId,
      threadTs: "1712345.0001",
      visibility: "private",
    }),
    surface: "slack" as const,
    ...overrides,
  };
  if (mode === "paused") {
    await saveTurnCheckpoint({ ...checkpoint, mode, reason });
  } else {
    await saveTurnCheckpoint({ ...checkpoint, mode });
  }
  await persistThreadStateById(CONVERSATION_ID, {
    conversation: {
      schemaVersion: 1,
      messages: [
        {
          id: "1712345.0001",
          role: "user",
          text: "inspect the deploy",
          createdAtMs: 1,
          author: { userId: "U123" },
        },
      ],
      processing: { activeTurnId: turnId },
      vision: { byFileId: {} },
    },
  });
  return turnId;
}

describe("durable queue contract", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });
  afterEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  describe("happy path", () => {
    it("runs one mention to one reply and leaves the conversation free", async () => {
      const q = await slack({
        // Second reply is for the later user mention in expectNextTurn.
        modelStream: createModelStream([
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ]),
      });
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });

      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectNextTurn(q, "1712345.0010");
    });

    it("publishes a resource wake from a channel-level Slack Location", async () => {
      // Watch Conversations have their own id, not a Slack thread id.
      const watchConversationId = "agent-dispatch:watch-1";
      const q = await slack({
        modelStream: createModelStream([
          { type: "text", text: "The subscribed check failed." },
          { type: "text", text: "The subscribed check recovered." },
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked." },
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Never sent.", waitFor: "abort" },
        ]),
      });
      const store = getConversationStore();
      await store.recordActivity({
        conversationId: watchConversationId,
        destination: SLACK_DESTINATION,
        nowMs: 1_000,
        sessionSource: createSlackSource({
          teamId: SLACK_DESTINATION.teamId,
          channelId: SLACK_DESTINATION.channelId,
          visibility: "public",
        }),
        source: "event",
        visibility: "public",
      });
      const message = createEventInboundMessage({
        event: {
          eventKey: "checks-failed-1",
          eventType: "pull_request.checks.failed",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: 1_100,
          trustedSummary: "The subscribed check failed.",
        },
        receivedAtMs: 1_100,
        subscription: {
          conversationId: watchConversationId,
          id: "resource-subscription-channel-1",
        },
        text: "The subscribed check failed.",
      });
      await appendAndEnqueueInboundMessage({
        message,
        queue: q.wakes,
        state: q.state,
      });
      queueSlackApiResponse("chat.postMessage", {
        body: chatPostMessageOk({ ts: "1712345.0042" }),
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      const turnId = conversationTurnIdForMessage(message.inboundMessageId);
      const posts = slackApiOutbox.messages();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.params).toMatchObject({
        channel: SLACK_DESTINATION.channelId,
        text: "The subscribed check failed.",
      });
      expect(posts[0]?.params).not.toHaveProperty("thread_ts");
      await expect(
        getTurnRecord(watchConversationId, turnId),
      ).resolves.toMatchObject({
        actors: [{ platform: "system", name: "event" }],
        state: "completed",
        surface: "slack",
      });
      await expect(
        store.getConversationIdByProviderConversation({
          provider: "slack",
          providerDestinationId: SLACK_DESTINATION.channelId,
          providerTenantId: SLACK_DESTINATION.teamId,
          providerConversationId: "1712345.0042",
        }),
      ).resolves.toBe(watchConversationId);
      const conversation = coerceThreadConversationState(
        await getPersistedThreadState(watchConversationId),
      );
      await hydrateConversationMessages({
        conversation,
        conversationId: watchConversationId,
      });
      expect(conversation.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            text: "The subscribed check failed.",
            meta: expect.objectContaining({
              replied: true,
              slackTs: "1712345.0042",
              source: "slack",
            }),
          }),
        ]),
      );

      // Later Watch Turns reply in the thread the first Message started.
      const followUp = createEventInboundMessage({
        event: {
          eventKey: "checks-recovered-1",
          eventType: "pull_request.checks.recovered",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: 200_000,
          trustedSummary: "The subscribed check recovered.",
        },
        receivedAtMs: 200_000,
        subscription: {
          conversationId: watchConversationId,
          id: "resource-subscription-channel-1",
        },
        text: "The subscribed check recovered.",
      });
      await appendAndEnqueueInboundMessage({
        message: followUp,
        queue: q.wakes,
        state: q.state,
      });
      queueSlackApiResponse("chat.postMessage", {
        body: chatPostMessageOk({ ts: "1712345.0043" }),
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      const followUpPosts = slackApiOutbox.messages();
      expect(followUpPosts).toHaveLength(2);
      expect(followUpPosts[1]?.params).toMatchObject({
        channel: SLACK_DESTINATION.channelId,
        thread_ts: "1712345.0042",
      });

      // JUNIOR-9D: a human reply in that thread runs in the Watch Conversation.
      // Its resume must find the reply and answer in the same thread.
      await q.send({ threadTs: "1712345.0042", ts: "1712345.0050" });
      await expect(q.next(almostSpentStartedAtMs(10_000))).resolves.toEqual({
        status: "yielded",
      });
      const replyTurnId = "turn_1712345_0050";
      await expect(
        getTurnRecord(watchConversationId, replyTurnId),
      ).resolves.toMatchObject({ state: "paused", resumeReason: "timeout" });

      queueSlackApiResponse("chat.postMessage", {
        body: chatPostMessageOk({ ts: "1712345.0051" }),
      });
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expect(
        getTurnRecord(watchConversationId, replyTurnId),
      ).resolves.toMatchObject({ state: "completed" });
      const replyPosts = slackApiOutbox.messages();
      expect(replyPosts).toHaveLength(3);
      expect(replyPosts[2]?.params).toMatchObject({
        channel: SLACK_DESTINATION.channelId,
        text: "Deploy checked.",
        thread_ts: "1712345.0042",
      });

      // A later reply yields, and its resumed worker dies before it saves.
      // The failure notice must reach the same thread with the footer.
      await q.send({ threadTs: "1712345.0042", ts: "1712345.0060" });
      await expect(q.next(almostSpentStartedAtMs(10_000))).resolves.toEqual({
        status: "yielded",
      });
      const lostTurnId = "turn_1712345_0060";
      const lostTurn = await getTurnRecord(watchConversationId, lostTurnId);
      if (lostTurn?.state !== "paused") throw new Error("expected paused turn");
      await saveTurnCheckpoint({
        conversationId: watchConversationId,
        errorMessage: LOST_WORKER_RESUME_MESSAGE,
        lostWorkerResumeCount: 1,
        messages: lostTurn.piMessages,
        mode: "paused",
        reason: "retry",
        sliceId: lostTurn.sliceId,
        turnId: lostTurnId,
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expect(
        getTurnRecord(watchConversationId, lostTurnId),
      ).resolves.toMatchObject({ state: "failed" });
      const failurePosts = slackApiOutbox.messages();
      expect(failurePosts).toHaveLength(4);
      expect(failurePosts[3]?.params).toMatchObject({
        channel: SLACK_DESTINATION.channelId,
        text: expect.stringContaining("I ran into an internal error"),
        thread_ts: "1712345.0042",
      });
      expect(JSON.stringify(failurePosts[3]?.params.blocks)).toContain(
        watchConversationId,
      );
    }, 30_000);
  });

  describe("long turn survives host limit", () => {
    it("re-parks when a later attempt times out before any new work is saved", async () => {
      // JUNIOR-7G: a second timeout must preserve the saved tool work.
      const q = await slack({
        modelStream: createModelStream([
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ]),
      });

      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      await expect(q.next(almostSpentStartedAtMs(2_500))).resolves.toEqual({
        status: "yielded",
      });

      const turnId = "turn_1712345_0001";
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({
        state: "paused",
        resumeReason: "timeout",
        turnId,
      });
      const afterYield = await getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state: q.state,
      });
      expect(afterYield).toMatchObject({
        needsRun: true,
        execution: { status: "paused" },
      });
      expect(afterYield?.lease).toBeUndefined();
      expect(q.replies()).toHaveLength(0);
      expect(q.wakes.hasQueuedMessages()).toBe(true);

      await expect(q.next(almostSpentStartedAtMs(2_500))).resolves.toEqual({
        status: "yielded",
      });
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({
        state: "paused",
        resumeReason: "timeout",
        turnId,
      });
      expect(q.replies()).toHaveLength(0);
      expect(q.wakes.hasQueuedMessages()).toBe(true);

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectAssistantInSql("Deploy checked.");
      await expectNextTurn(q, "1712345.0012");
    }, 30_000);
  });

  describe("another person's mention", () => {
    it("starts its own Turn after the execution slice times out instead of steering that Turn", async () => {
      // The mention waits while the first person's Turn runs, until the
      // execution slice times out. The next Run must start the mention's own
      // Turn, not steer it into a Turn that runs with another person's
      // credentials.
      const q = await slack();
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const otherText = "can you check my deploy too?";
      await expect(
        q.send({
          text: `<@${SLACK_BOT_USER_ID}> ${otherText}`,
          threadTs: "1712345.0001",
          ts: "1712345.0002",
          user: "U0OTHER",
        }),
      ).resolves.toMatchObject({ status: 200 });
      // Fault: the host deadline is spent, so the execution slice times out
      // while its model request is in flight.
      await expect(q.next(almostSpentStartedAtMs(0))).resolves.toEqual({
        status: "yielded",
      });
      const turnId = "turn_1712345_0001";
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({
        actor: expect.objectContaining({ userId: "U123" }),
        state: "paused",
        resumeReason: "timeout",
      });

      while (q.wakes.hasQueuedMessages()) {
        await q.next();
      }

      await expectAnotherPersonsTurn(q, { endedTurnId: turnId, otherText });
    }, 30_000);

    it("steers the author's own mention into the Turn after the execution slice times out", async () => {
      // The Turn's author mentions Junior again while the Turn waits for its
      // next Run. The mention joins that Turn.
      const q = await slack();
      await q.send();
      await expect(q.next(almostSpentStartedAtMs(0))).resolves.toEqual({
        status: "yielded",
      });
      await q.send({
        text: `<@${SLACK_BOT_USER_ID}> check staging too`,
        threadTs: "1712345.0001",
        ts: "1712345.0002",
      });
      while (q.wakes.hasQueuedMessages()) {
        await q.next();
      }
      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
    }, 30_000);

    it("ends a running Turn at its next step and starts the other person's Turn", async () => {
      // Another person mentions Junior while a multi-step Turn waits on its
      // model. The Turn ends at its next step, before its execution slice
      // ends, and the mention starts its own Turn as its author.
      const requested = deferred();
      const release = deferred();
      const q = await slack({
        modelStream: createModelStream([
          {
            type: "toolCall",
            name: "systemTime",
            arguments: {},
            onRequest: () => requested.resolve(),
            waitFor: release.promise,
          },
          { type: "text", text: "Deploy checked." },
        ]),
      });
      const otherText = "can you check my deploy too?";
      const otherMention = {
        text: `<@${SLACK_BOT_USER_ID}> ${otherText}`,
        threadTs: "1712345.0001",
        ts: "1712345.0002",
        user: "U0OTHER",
      };
      // Turn preparation backfills the thread from Slack, which already has
      // the other person's mention.
      queueSlackApiResponse("conversations.replies", {
        body: conversationsRepliesPage({
          threadTs: "1712345.0001",
          messages: [
            {
              ts: "1712345.0001",
              thread_ts: "1712345.0001",
              user: "U123",
              text: `<@${SLACK_BOT_USER_ID}> inspect the deploy`,
            },
            { thread_ts: "1712345.0001", ...otherMention },
          ],
        }),
      });
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const run = q.next();
      await requested.promise;
      await expect(q.send(otherMention)).resolves.toMatchObject({
        status: 200,
      });
      release.resolve();
      await expect(run).resolves.toEqual({ status: "yielded" });

      // The Turn yields at its next step, not at a timeout.
      const turnId = "turn_1712345_0001";
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({ state: "paused", resumeReason: "yield" });

      while (q.wakes.hasQueuedMessages()) {
        await q.next();
      }
      await expectAnotherPersonsTurn(q, { endedTurnId: turnId, otherText });
    }, 30_000);
  });

  describe("stop", () => {
    it("stops a paused turn before its next run can reply", async () => {
      // The first run yields at the host deadline. The person says `stop`
      // before the turn continues. The next run must see the stop and end
      // the turn without the reply.
      const q = await slack();
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      await expect(q.next(almostSpentStartedAtMs(0))).resolves.toEqual({
        status: "yielded",
      });
      const turnId = "turn_1712345_0001";
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({ state: "paused" });

      const stop = {
        eventType: "message" as const,
        text: "stop",
        threadTs: "1712345.0001",
        ts: "1712345.0100",
      };
      await expect(q.send(stop)).resolves.toMatchObject({ status: 200 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });

      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({ state: "abandoned" });
      // Only the stop acknowledgment posts. The paused turn never replies.
      expect(q.replies()).toEqual([SLACK_STOP_ACK]);
      // The stop queued its own wake. It finds no work left.
      await expect(q.next()).resolves.toEqual({ status: "no_work" });
      // A mention sent before the stop but delivered after it runs, but it
      // does not end the stop: only input sent after the stop does. A Slack
      // retry of the old stop does not stop the Turn that the mention starts.
      await expect(
        q.send({
          text: `<@${SLACK_BOT_USER_ID}> check the deploy`,
          threadTs: "1712345.0001",
          ts: "1712345.0050",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(q.next(almostSpentStartedAtMs(0))).resolves.toEqual({
        status: "yielded",
      });
      await expect(q.send(stop)).resolves.toMatchObject({ status: 200 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(q.replies()).toEqual([SLACK_STOP_ACK, "Deploy checked."]);
      await expect(getConversationStoppedAtMs(CONVERSATION_ID)).resolves.toBe(
        1_712_345_010,
      );

      // A later mention ends the stop.
      await expect(
        q.send({
          text: `<@${SLACK_BOT_USER_ID}> check the next deploy`,
          threadTs: "1712345.0001",
          ts: "1712346.0001",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(q.next(almostSpentStartedAtMs(0))).resolves.toEqual({
        status: "yielded",
      });
      await expect(
        getConversationStoppedAtMs(CONVERSATION_ID),
      ).resolves.toBeUndefined();
    }, 30_000);
  });

  describe("accepted reply is terminal", () => {
    it("completes once when the host deadline hits during Slack accept", async () => {
      // JUNIOR-7Y: mention → model reply → Slack accept dual-writes SQL → host
      // deadline expires during that accept → turn completes once, no second post.
      const slackSeen = deferred();
      const releaseSlack = deferred();
      queueSlackApiResponse("chat.postMessage", {
        body: chatPostMessageOk({ ts: "1712345.0002" }),
        onRequest: () => slackSeen.resolve(),
        waitFor: releaseSlack.promise,
      });
      const remainingMs = 2_500;
      const startedAtMs = almostSpentStartedAtMs(remainingMs);
      const deadlineAtMs = startedAtMs + requestBudgetMs();
      const q = await slack({
        modelStream: createModelStream([
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ]),
      });

      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const turn = q.next(startedAtMs);
      await slackSeen.promise;
      const waitForDeadlineMs = Math.max(0, deadlineAtMs - Date.now() + 25);
      await new Promise((resolve) => setTimeout(resolve, waitForDeadlineMs));
      releaseSlack.resolve();

      await expect(turn).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId: "turn_1712345_0001",
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectAssistantInSql("Deploy checked.");
      await expectNextTurn(q, "1712345.0008");
    });

    it("completes seeded dead-worker residue after an accepted reply", async () => {
      // Seeded residue only: a live process cannot leave this state in-process.
      // Recovery must complete without a failure fallback or a second Slack post.
      const turnId = await seedDeadWorkerResidue("running");
      await commitAcceptedReply({
        agentMessage: fauxAssistantMessage("Deploy checked."),
        conversationId: CONVERSATION_ID,
        conversationMessageId: `${turnId}:assistant:1`,
        conversation: {
          schemaVersion: 1,
          messages: [
            {
              id: "1712345.0001",
              role: "user",
              text: "inspect the deploy",
              createdAtMs: 1,
              author: { userId: "U123" },
              meta: { replied: true },
            },
            {
              id: `${turnId}:assistant:1`,
              role: "assistant",
              text: "Deploy checked.",
              createdAtMs: 2,
              author: { isBot: true },
              meta: { replied: true, slackTs: "1712345.0002" },
            },
          ],
          processing: { activeTurnId: turnId },
          vision: { byFileId: {} },
        },
      });
      const q = await slack();
      await requestConversationWork({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        nowMs: 1_000,
        state: q.state,
      });
      await startConversationWork({
        conversationId: CONVERSATION_ID,
        nowMs: 1_000,
        state: q.state,
      });
      await recoverConversationWork({
        nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue: q.wakes,
        state: q.state,
      });

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: [],
      });
      await expectNextTurn(q, "1712345.0003");
    });
  });

  describe("worker dies mid-run", () => {
    it("resumes from the last save when the worker stops checking in", async () => {
      // A blocked event loop and a dead process both leave this residue. The
      // next wake resumes the turn and replies once, without an error reply.
      const turnId = await seedDeadWorkerResidue("running");
      const q = await slack();
      await expireDeadWorkerLease(q);

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectAssistantInSql("Deploy checked.");
    });

    it("fails once when the resumed turn loses its worker again", async () => {
      // A second loss fails the turn once, keeps committed history, and
      // leaves the conversation free.
      const turnId = await seedDeadWorkerResidue("running", {
        lostWorkerResumeCount: 1,
      });
      const q = await slack();
      await expireDeadWorkerLease(q);

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(q.wakes.sentRecords()).toHaveLength(1);
      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "lost its worker",
      });
      await expectNextTurn(q, "1712345.0006");
      // The next turn was told that this one failed.
      expect(
        JSON.stringify(
          await loadProjection({ conversationId: CONVERSATION_ID }),
        ),
      ).toContain("Your previous turn failed before it finished.");
    });

    it("fails once when the resumed turn stops before its first save", async () => {
      // Recovery runs the resumed turn right away. A worker that stops before
      // its first save leaves the resume message on the paused turn.
      const turnId = await seedDeadWorkerResidue("paused", {
        errorMessage: LOST_WORKER_RESUME_MESSAGE,
        lostWorkerResumeCount: 1,
        reason: "retry",
      });
      const q = await slack();
      await expireDeadWorkerLease(q);

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "lost its worker",
      });
      await expectNextTurn(q, "1712345.0006");
    });

    /**
     * Fault: hold a worker inside a model request until its lease expires.
     * In JUNIOR-G1 a synchronous webFetch conversion blocked one instance's
     * event loop for 201s. Its workers missed every check-in, another worker
     * took over the Turn, and the first worker came back with an answer. The
     * test runs inside one check-in interval, so the held worker also sends
     * no check-in.
     */
    function stall(stalled: { resolve(): void }, release: Promise<void>) {
      return { onRequest: () => stalled.resolve(), waitFor: release };
    }

    it("replies once when a stalled worker comes back after recovery finished the Turn", async () => {
      const stalled = deferred();
      const release = deferred();
      const q = await slack({
        modelStream: createModelStream([
          { type: "toolCall", name: "systemTime", arguments: {} },
          // The held worker gets its answer only after recovery replied.
          {
            type: "text",
            text: "Stale answer.",
            ...stall(stalled, release.promise),
          },
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ]),
      });
      const turnId = "turn_1712345_0001";
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const stalledWorker = q.next();
      await stalled.promise;

      await expireLiveWorkerLease(q, CONVERSATION_WORK_LEASE_TTL_MS);
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      release.resolve();
      await stalledWorker;

      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectNextTurn(q, "1712345.0006");
    }, 30_000);

    it("keeps a failed Turn failed when its stalled worker comes back", async () => {
      // Both workers stall, so recovery fails the Turn on the second loss.
      const firstStalled = deferred();
      const firstRelease = deferred();
      const secondStalled = deferred();
      const secondRelease = deferred();
      const q = await slack({
        modelStream: createModelStream([
          { type: "toolCall", name: "systemTime", arguments: {} },
          {
            type: "toolCall",
            name: "systemTime",
            arguments: {},
            ...stall(firstStalled, firstRelease.promise),
          },
          {
            type: "toolCall",
            name: "systemTime",
            arguments: {},
            ...stall(secondStalled, secondRelease.promise),
          },
          { type: "text", text: "Deploy checked." },
        ]),
      });
      const turnId = "turn_1712345_0001";
      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const firstWorker = q.next();
      await firstStalled.promise;
      await expireLiveWorkerLease(q, CONVERSATION_WORK_LEASE_TTL_MS);
      const secondWorker = q.next();
      await secondStalled.promise;
      await expireLiveWorkerLease(q, 2 * CONVERSATION_WORK_LEASE_TTL_MS);
      await expect(q.next()).resolves.toEqual({ status: "completed" });

      secondRelease.resolve();
      await secondWorker;
      firstRelease.resolve();
      await firstWorker;

      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "lost its worker",
      });
      expect(q.replies()[0]).toContain("I ran into an internal error");
      await expectNextTurn(q, "1712345.0006");
    }, 30_000);

    it("fails once when the lost turn has no slice left to resume", async () => {
      const turnId = await seedDeadWorkerResidue("running", {
        sliceId: botConfig.maxSlicesPerTurn,
      });
      const q = await slack();
      await expireDeadWorkerLease(q);

      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "failed",
        replies: 1,
        error: "lost its worker",
      });
      await expectNextTurn(q, "1712345.0006");
    });
  });
});
