import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS, getChatConfig } from "@/chat/config";
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
  CONVERSATION_WORK_LEASE_TTL_MS,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  listTurnSummaries,
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
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import { createModelStream } from "../fixtures/model-stream";
import { createModelAgentRunner } from "../fixtures/agent-runner";

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
 * First model step calls a real no-side-effect tool so the agent reaches a
 * safe mid-work boundary. The next model step waits on `holdAfterTool` so the
 * host deadline can expire at that boundary (yield or timeout park). Later
 * steps return plain assistant text for resume and follow-up turns.
 */
function streamMidWorkThenReplies(
  holdAfterTool: Promise<void>,
  ...finalTexts: string[]
): StreamFn {
  const [firstFinal, ...restFinals] = finalTexts;
  if (!firstFinal) {
    throw new Error(
      "streamMidWorkThenReplies requires at least one final text",
    );
  }
  return createModelStream([
    { type: "toolCall", name: "systemTime", arguments: {} },
    // Held long enough for the host deadline to force park at the tool boundary.
    { type: "text", text: firstFinal, waitFor: holdAfterTool },
    // Resume after park (and any aborted in-flight call) still has a final reply.
    { type: "text", text: firstFinal },
    ...restFinals.map((text) => ({ type: "text" as const, text })),
  ]);
}

/**
 * Same first-slice park as `streamMidWorkThenReplies`, then the resume model
 * step waits on `holdOnResume`. Use this when the second host request should
 * time out before any new work is saved.
 */
function streamMidWorkThenHoldOnResume(
  holdAfterTool: Promise<void>,
  holdOnResume: Promise<void>,
  ...finalTexts: string[]
): StreamFn {
  const [firstFinal, ...restFinals] = finalTexts;
  if (!firstFinal) {
    throw new Error(
      "streamMidWorkThenHoldOnResume requires at least one final text",
    );
  }
  return createModelStream([
    { type: "toolCall", name: "systemTime", arguments: {} },
    { type: "text", text: firstFinal, waitFor: holdAfterTool },
    // Aborted first-slice model call may still consume a slot.
    { type: "text", text: firstFinal, waitFor: holdOnResume },
    // Fresh resume model call: hold until the second host deadline is spent.
    { type: "text", text: firstFinal, waitFor: holdOnResume },
    // Leftover replies if the turn somehow continues, plus later mentions.
    { type: "text", text: firstFinal },
    ...restFinals.map((text) => ({ type: "text" as const, text })),
  ]);
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
    services: { replyExecutor: { agentRunner } },
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
async function seedDeadWorkerResidue(mode: "paused" | "running") {
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
  };
  if (mode === "paused") {
    await saveTurnCheckpoint({ ...checkpoint, mode, reason: "timeout" });
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
  });

  describe("long turn survives host limit", () => {
    it("parks mid-work under a spent deadline, then finishes on a fresh wake", async () => {
      // Live multi-slice shape: mention → tool work → host deadline at the
      // post-tool model step → park → fresh queue wake → final reply.
      // Only model stream + Slack HTTP are faked.
      const releaseAfterTool = deferred<void>();
      const remainingMs = 2_500;
      const startedAtMs = almostSpentStartedAtMs(remainingMs);
      const deadlineAtMs = startedAtMs + requestBudgetMs();
      const q = await slack({
        modelStream: streamMidWorkThenReplies(
          releaseAfterTool.promise,
          "Deploy checked.",
          "Deploy checked.",
        ),
      });

      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const firstSlice = q.next(startedAtMs);
      // Let the tool boundary land, then hold the next model step past the
      // host deadline so the worker parks instead of finishing this request.
      const waitForDeadlineMs = Math.max(0, deadlineAtMs - Date.now() + 50);
      await new Promise((resolve) => setTimeout(resolve, waitForDeadlineMs));
      releaseAfterTool.resolve(undefined);
      await expect(firstSlice).resolves.toEqual({ status: "yielded" });

      const turnId = "turn_1712345_0001";
      // Holding the next model step past the host deadline marks the agent
      // timed out and parks for resume (production multi-slice shape).
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
      expect(q.wakes.hasQueuedMessages()).toBe(true);
      expect(q.replies()).toHaveLength(0);

      // Fresh host request finishes the same turn with one destination post.
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      await expectTerminalTurn(q, {
        turnId,
        state: "completed",
        replies: ["Deploy checked."],
      });
      await expectAssistantInSql("Deploy checked.");
      await expectNextTurn(q, "1712345.0011");
    });

    it("re-parks when a later attempt times out before any new work is saved", async () => {
      // JUNIOR-7G: first attempt parks after real tool work. The next wake
      // spends the whole host budget on the model call and saves nothing new.
      // That attempt must re-park (not fail), then a full-budget wake finishes.
      const releaseAfterTool = deferred<void>();
      const releaseOnResume = deferred<void>();
      const remainingMs = 2_500;
      const firstStartedAtMs = almostSpentStartedAtMs(remainingMs);
      const firstDeadlineAtMs = firstStartedAtMs + requestBudgetMs();
      const q = await slack({
        modelStream: streamMidWorkThenHoldOnResume(
          releaseAfterTool.promise,
          releaseOnResume.promise,
          "Deploy checked.",
          "Deploy checked.",
        ),
      });

      await expect(q.send()).resolves.toMatchObject({ status: 200 });
      const firstSlice = q.next(firstStartedAtMs);
      const waitForFirstDeadlineMs = Math.max(
        0,
        firstDeadlineAtMs - Date.now() + 50,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, waitForFirstDeadlineMs),
      );
      releaseAfterTool.resolve(undefined);
      await expect(firstSlice).resolves.toEqual({ status: "yielded" });

      const turnId = "turn_1712345_0001";
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({
        state: "paused",
        resumeReason: "timeout",
        turnId,
      });
      expect(q.replies()).toHaveLength(0);
      expect(q.wakes.hasQueuedMessages()).toBe(true);

      const secondStartedAtMs = almostSpentStartedAtMs(remainingMs);
      const secondDeadlineAtMs = secondStartedAtMs + requestBudgetMs();
      const secondSlice = q.next(secondStartedAtMs);
      const waitForSecondDeadlineMs = Math.max(
        0,
        secondDeadlineAtMs - Date.now() + 50,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, waitForSecondDeadlineMs),
      );
      releaseOnResume.resolve(undefined);

      // Short leftover budget still parks cleanly instead of failing the turn.
      await expect(secondSlice).resolves.toEqual({ status: "yielded" });
      await expect(
        getTurnRecord(CONVERSATION_ID, turnId),
      ).resolves.toMatchObject({
        state: "paused",
        resumeReason: "timeout",
        turnId,
      });
      expect(q.replies()).toHaveLength(0);
      expect(q.wakes.hasQueuedMessages()).toBe(true);

      // Fresh full-budget wake finishes the same turn with one reply.
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
    it("fails once when the worker disappears before any reply", async () => {
      // Dead-worker residue: heartbeat expires the lease, next wake fails the
      // turn once, keeps committed history, and leaves the conversation free.
      const turnId = await seedDeadWorkerResidue("running");
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

      await expect(
        recoverConversationWork({
          nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
          queue: q.wakes,
          state: q.state,
        }),
      ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
      await expect(q.next()).resolves.toEqual({ status: "completed" });
      expect(q.wakes.sentRecords()).toHaveLength(1);
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
