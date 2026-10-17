import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationIdForEvents,
  getAgentInvocationIdForResult,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import { loadCausingTurn } from "@/chat/agent-invocations/markers";
import {
  enqueueAgentInvocationResult,
  startAgentInvocationsForChildInput,
} from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import { createAgentInvocationWorker } from "@/chat/agent-invocations/work";
import type { AgentRun } from "@/chat/agent/types";
import { credentialContextForActor } from "@/chat/credentials/context";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { createEventInboundMessage } from "@/chat/events/notification";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getConversationWorkState,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const slackParentConversationId = "slack:C123:1712345.0001";
const slackDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;
const slackInvocationInput = {
  actor: {
    platform: "slack",
    teamId: "T123",
    userId: "U123",
  } as const,
  destination: slackDestination,
  input: "Summarize the durable task.",
  parentConversationId: slackParentConversationId,
  reasoningLevel: "medium" as const,
};

async function prepareSlackParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: slackParentConversationId,
    destination: slackDestination,
    nowMs: 1_000,
    sessionSource: createSlackSource({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1712345.0001",
      visibility: "public",
    }),
    source: "slack",
    visibility: "public",
  });
  return { fixture };
}

async function listAgents(conversationId: string) {
  return (await createListAgentsTool({ conversationId }).execute!({}, {}))
    .agents;
}

describe("nested agent invocations", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("sends each nested child's report to its parent once its own children finish", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const context = (
      conversationId: string,
      messages: InboundMessage[] = [],
    ): ConversationWorkerContext => ({
      attempt: {
        ack: async () => undefined,
        conversationId,
        drain: async () => [],
        isFinalAttempt: false,
        messages,
      },
      checkIn: async () => true,
      conversationId,
      shouldYield: () => false,
    });
    const mailbox = async (conversationId: string) =>
      (await getConversationWorkState({ conversationId, state }))?.messages ??
      [];
    const complete = async (invocationId: string, result: string) =>
      (await completeAgentInvocation({
        invocationId,
        result,
        status: "completed",
      })) as TerminalAgentInvocation;
    // Send one result to its parent child, as the worker does, and return the
    // agent invocation that the result starts there.
    const sendToChild = async (result: TerminalAgentInvocation) => {
      await enqueueAgentInvocationResult(result, { queue, state });
      const messages = (await mailbox(result.parentConversationId)).filter(
        (message) =>
          message.inboundMessageId ===
          getAgentInvocationResultMessageId(result.invocationId),
      );
      expect(messages).toHaveLength(1);
      // A retried delivery starts the same agent invocation.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          startAgentInvocationsForChildInput(
            context(result.parentConversationId, messages),
            { queue, state },
          ),
        ).resolves.toEqual({ status: "completed" });
      }
      return (await getAgentInvocation(
        getAgentInvocationIdForResult(result.invocationId),
      ))!;
    };
    try {
      const child = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-child",
      });
      const userCredentials = credentialContextForActor(
        slackInvocationInput.actor,
      );
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        credentialContext: userCredentials,
        idempotencyKey: "nested-helper",
        parentConversationId: child.childConversationId,
      });
      const grandHelper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "nested-grand-helper",
        parentConversationId: helper.childConversationId,
      });

      // With maxAgentDepth 1, depth 1 can spawn and depth 2 cannot. Both read
      // the root Location.
      const runs: AgentRun[] = [];
      const worker = createAgentInvocationWorker(
        {
          run: async (run) => {
            runs.push(run);
            throw new Error("stop after reading the run");
          },
        },
        { maxAgentDepth: 1 },
      );
      for (const invocation of [child, helper]) {
        await expect(
          worker(
            context(invocation.childConversationId),
            invocation.invocationId,
          ),
        ).rejects.toThrow("stop after reading the run");
      }
      expect(runs.map((run) => run.disabledFeatures)).toEqual([
        ["handoff", "interactive-auth"],
        ["handoff", "interactive-auth", "subagents"],
      ]);
      expect(runs[1]?.location).toMatchObject({
        provider: "slack",
        channelId: "C123",
      });

      // A child that finishes while its own child runs does not report yet.
      for (const invocation of [child, helper]) {
        await expect(
          complete(invocation.invocationId, "Started a helper."),
        ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      }

      const grandResult = await complete(
        grandHelper.invocationId,
        "Grand helper fact: 42.",
      );
      expect(grandResult).toMatchObject({ parentMailboxStatus: "pending" });
      // A timer fires on the helper first. Its agent invocation runs as the
      // event system Actor with the grants of that one timer.
      const timerMessage = createEventInboundMessage({
        event: {
          eventKey: "helper-timer",
          eventType: "timer.fired",
          identifier: "helper-timer",
          namespace: "junior",
          occurredAtMs: 1,
          trustedSummary: "Timer fired",
        },
        // The burst window has passed.
        receivedAtMs: 0,
        subscription: {
          conversationId: helper.childConversationId,
          credentialSubject: bindTimerWatchCredentialSubject({
            conversationId: helper.childConversationId,
            userId: slackInvocationInput.actor.userId,
            watchId: "helper-timer",
          }),
          id: "helper-timer",
        },
        text: "Check the grand helper.",
      });
      await startAgentInvocationsForChildInput(
        context(helper.childConversationId, [timerMessage]),
        { queue, state },
      );
      const timerInvocation = (await getAgentInvocation(
        getAgentInvocationIdForEvents(timerMessage.inboundMessageId),
      ))!;
      expect(timerInvocation).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        credentialContext: {
          subject: expect.objectContaining({ allowedWhen: "timer-watch" }),
        },
      });
      await expect(
        complete(timerInvocation.invocationId, "Still waiting."),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
      // The result that arrives after the timer continues the helper's task.
      // It does not take the event Actor or the timer's grants.
      const helperContinuation = await sendToChild(grandResult);
      expect(helperContinuation).toMatchObject({
        actor: slackInvocationInput.actor,
        childConversationId: helper.childConversationId,
        credentialContext: userCredentials,
        input: expect.stringContaining("Grand helper fact: 42."),
        parentConversationId: child.childConversationId,
        status: "pending",
      });
      // Its Turn takes the task Actor of the grand helper Turn that sent the
      // result.
      await expect(loadCausingTurn(helperContinuation)).resolves.toEqual({
        conversationId: grandHelper.childConversationId,
        turnId: getAgentInvocationTurnId(grandHelper.invocationId),
      });
      // listAgents shows the state of open work. A `replaced` child still
      // has work, and an agent invocation that receives a result is not a task.
      const listedChild = (childConversationId: string) => ({
        conversation_id: childConversationId,
        relation: "child",
        status: "pending",
        task: slackInvocationInput.input,
        updated_at: expect.any(String),
      });
      await expect(listAgents(slackParentConversationId)).resolves.toEqual([
        listedChild(child.childConversationId),
      ]);
      await expect(listAgents(child.childConversationId)).resolves.toEqual([
        listedChild(helper.childConversationId),
      ]);

      // Each child reports once, from the agent invocation that received the
      // last result of its own children.
      const helperResult = await complete(
        helperContinuation.invocationId,
        "Helper fact: 42.",
      );
      expect(helperResult).toMatchObject({ parentMailboxStatus: "pending" });
      const childContinuation = await sendToChild(helperResult);
      const childResult = await complete(
        childContinuation.invocationId,
        "Final answer: 42.",
      );
      expect(childResult).toMatchObject({ parentMailboxStatus: "pending" });
      await enqueueAgentInvocationResult(childResult, { queue, state });
      expect(await mailbox(slackParentConversationId)).toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            childContinuation.invocationId,
          ),
          input: expect.objectContaining({
            text: expect.stringContaining("Final answer: 42."),
          }),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
