import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
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
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationStore } from "@/chat/db";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { LOST_WORKER_RESUME_MESSAGE } from "@/chat/task-execution/paused-turn";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  SLACK_BOT_USER_ID,
  createConversationWorkHarness,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../fixtures/conversation-work";
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import {
  createModelStream,
  type FixedModelOutput,
} from "../fixtures/model-stream";
import { createModelAgentRunner } from "../fixtures/agent-runner";
import { createEventInboundMessage } from "@/chat/events/notification";
import { conversationTurnIdForMessage } from "@/chat/conversations/web-input";
import { stopConversationTurn } from "@/chat/conversations/stop";
import {
  clock,
  closers,
  lastTurnEnd,
  owners,
  signals,
  slackReplies,
} from "../fixtures/turn-lifecycle";

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
async function slack(options: { outputs?: FixedModelOutput[] } = {}) {
  const agentRunner = createModelAgentRunner(
    createModelStream(
      options.outputs ?? [{ type: "text", text: "Deploy checked." }],
    ),
  );
  const work = await createConversationWorkHarness(agentRunner, {
    services: { agentRunner },
  });
  const wakes = work.queue;
  return {
    ...work,
    agentRunner,
    wakes,
    replies: slackReplies,
    next: async (requestStartedAtMs?: number) => {
      // Use production worker shouldYield (lease + host request deadline).
      const process = async () => await work.process(wakes.takeMessage());
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
          getSlackAdapter: () => work.adapter,
          queue: wakes,
          runtime: work.runtime,
          state: work.state,
        },
      }),
  };
}

type QueueTest = Awaited<ReturnType<typeof slack>>;

/** Assert the durable state left by a turn that cannot run again. */
async function expectTerminalTurn(
  q: QueueTest,
  expected: {
    turnId: string;
    state: "completed" | "failed";
    replies: string[] | number;
    error?: string;
  },
): Promise<void> {
  const record = await getTurnRecord(CONVERSATION_ID, expected.turnId);
  expect(record).toMatchObject({
    state: expected.state,
    turnId: expected.turnId,
  });
  expect(record?.errorMessage ?? "").toContain(expected.error ?? "");
  await expect(listTurnSummaries(CONVERSATION_ID)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: expected.state,
        turnId: expected.turnId,
      }),
    ]),
  );

  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(CONVERSATION_ID),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId: CONVERSATION_ID,
  });
  expect(conversation.processing.activeTurnId).toBeUndefined();
  expect(conversation.processing.pendingAuth).toBeUndefined();
  await expect(
    getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: q.state,
    }),
  ).resolves.toMatchObject({ needsRun: false, messages: [] });
  expect(q.wakes.hasQueuedMessages()).toBe(false);

  const replies = q.replies();
  const replyCount =
    typeof expected.replies === "number"
      ? expected.replies
      : expected.replies.length;
  const expectedReplies =
    typeof expected.replies === "number" ? replies : expected.replies;
  expect(replies).toHaveLength(replyCount);
  expect(replies).toEqual(expectedReplies);
}

/** Prove that a terminal turn does not block a later user request. */
async function expectNextTurn(q: QueueTest, ts: string): Promise<void> {
  const priorTurns = new Set(
    (await listTurnSummaries(CONVERSATION_ID)).map((turn) => turn.turnId),
  );
  const priorReplies = q.replies();
  await q.send({
    text: `<@${SLACK_BOT_USER_ID}> check the next deploy`,
    threadTs: "1712345.0001",
    ts,
  });
  await expect(q.next()).resolves.toEqual({ status: "completed" });

  const nextTurn = (await listTurnSummaries(CONVERSATION_ID)).find(
    (turn) => !priorTurns.has(turn.turnId),
  );
  if (!nextTurn) throw new Error("Expected a new turn");
  expect(nextTurn).toMatchObject({ state: "completed" });
  await expectTerminalTurn(q, {
    turnId: nextTurn.turnId,
    state: "completed",
    replies: [...priorReplies, "Deploy checked."],
  });
}

async function expectAssistantInSql(text: string): Promise<void> {
  await expect(
    loadProjection({ conversationId: CONVERSATION_ID }),
  ).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text,
          }),
        ]),
      }),
    ]),
  );
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
      compactions: [],
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
        outputs: [
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ],
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
        outputs: [
          { type: "text", text: "The subscribed check failed." },
          { type: "text", text: "The subscribed check recovered." },
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked." },
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Never sent.", waitFor: "abort" },
        ],
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
        outputs: [
          { type: "toolCall", name: "systemTime", arguments: {} },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked.", waitFor: "abort" },
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ],
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
        outputs: [
          { type: "text", text: "Deploy checked." },
          { type: "text", text: "Deploy checked." },
        ],
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
          compactions: [],
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
    async function expireDeadWorkerLease(q: QueueTest): Promise<void> {
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
      await expect(
        recoverConversationWork({
          nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
          queue: q.wakes,
          state: q.state,
        }),
      ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    }

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

/**
 * One table for the Turn lifecycle of every work owner. Each row runs real
 * production routing: input reaches the queue, the conversation worker picks
 * the owner, and the real agent runs with fixed model output. Root owners
 * deliver to a person. A child owner reports to its parent agent instead.
 */
describe("Turn lifecycle for each work owner", () => {
  beforeEach(() => {
    resetSlackApiMockState();
    clock.nowMs = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock.nowMs);
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    resetSlackApiMockState();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  describe.each(owners)("$name", (owner) => {
    it.each(signals)("$name", async (signal) => {
      let conversationId = "";
      let stopping: Promise<unknown> | undefined;
      const harness = await slack({
        outputs: [
          ...(owner.setupOutputs ?? []),
          ...signal.outputs({
            reply: owner.reply ?? ((text) => ({ type: "text", text })),
            stop: () => {
              stopping = stopConversationTurn({
                conversationId,
                queue: harness.queue,
                state: harness.state,
              });
            },
          }),
        ],
      });
      conversationId = await owner.start(harness);
      const process = async (softYieldAfterMs?: number) =>
        await harness.process(
          harness.queue.takeMessageFor(conversationId),
          softYieldAfterMs === undefined ? {} : { softYieldAfterMs },
        );
      await owner.setup?.({ conversationId, harness, process });
      // Run each wake of this Conversation until no work is left.
      const wakes: string[] = [];
      while (
        wakes.length < CONVERSATION_WORK_MAX_RETRIES + 2 &&
        harness.queue
          .queuedMessages()
          .some((message) => message.conversationId === conversationId)
      ) {
        if (signal.failFromWake === wakes.length) {
          // A model error ends the Run with a failed outcome. Only an error
          // that the runner throws, such as a lost store, retries the wake.
          vi.spyOn(harness.agentRunner, "run").mockRejectedValue(
            new Error("agent unavailable"),
          );
        }
        const result = await process(
          signal.yieldFirst && wakes.length === 0 ? 0 : undefined,
        );
        wakes.push(result.status);
        // Each retry wake has a new idempotency key from the clock.
        clock.nowMs += 1_000;
      }
      await stopping;

      const expected = signal.expected(owner);
      expect({
        wakes,
        turn: await lastTurnEnd(conversationId),
        shown: await owner.read(conversationId),
      }).toEqual(expected);
    });
  });
});
