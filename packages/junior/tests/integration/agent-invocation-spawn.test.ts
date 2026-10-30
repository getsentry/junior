import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationId,
  getAgentInvocationIdForResult,
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  enqueueAgentInvocationResult,
  startAgentInvocationsForChildInput,
} from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createAgentInvocationWorker } from "@/chat/agent-invocations/work";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { createSpawnAgentTool } from "@/chat/tools/runtime/spawn-agent";
import type { AgentRun } from "@/chat/agent/types";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  recoverPendingAgentInvocationMailboxAppends,
  recoverPendingAgentInvocationResults,
} from "@/chat/agent-dispatch/heartbeat";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  createLocalSource,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import {
  destination,
  invocationInput,
  parentConversationId,
  slackInvocationInput,
  slackParentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  loadSubagentEvents,
} from "../fixtures/agent-invocations";

describe("agent invocation spawn and result delivery", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("keeps each name to one child and idempotent invocation input immutable", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    try {
      const first = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-1",
        },
        2_000,
      );
      const replay = await createAgentInvocation(
        {
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-1",
        },
        3_000,
      );
      await completeAgentInvocation({
        invocationId: first.invocationId,
        result: "Finished.",
        status: "completed",
      });
      // A finished child keeps its name. A new task for it is a message.
      await expect(
        createAgentInvocation(
          {
            ...invocationInput,
            agentName: "researcher",
            idempotencyKey: "named-2",
          },
          4_000,
        ),
      ).rejects.toMatchObject({ name: "AgentNameInUseError" });
      // A replay of the first task still returns it after it finished.
      await expect(
        createAgentInvocation({
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "named-1",
        }),
      ).resolves.toMatchObject({
        invocationId: first.invocationId,
        status: "completed",
      });
      const unnamed = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-1",
        },
        5_000,
      );
      const unnamedReplay = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-1",
        },
        6_000,
      );
      const otherUnnamed = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "unnamed-2",
        },
        7_000,
      );

      expect(replay).toEqual(first);
      expect(unnamedReplay.childConversationId).toBe(
        unnamed.childConversationId,
      );
      expect(otherUnnamed.childConversationId).not.toBe(
        unnamed.childConversationId,
      );
      const child = await conversationStore.get({
        conversationId: first.childConversationId,
      });
      expect(child).toMatchObject({
        parentConversationId,
        source: "internal",
      });
      expect(child).not.toHaveProperty("destination");
      await expect(
        createAgentInvocation({
          ...invocationInput,
          idempotencyKey: "named-1",
          input: "Different input must not reuse the key.",
          agentName: "researcher",
        }),
      ).rejects.toThrow("idempotency key was reused with different input");
    } finally {
      await fixture.close();
    }
  });

  it("derives spawn authority from the parent run and replays one tool call", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    try {
      const request = {
        conversationId: parentConversationId,
        turnId: "parent-turn",
        instruction: { text: "Delegate the investigation." },
        actor: { platform: "local", userId: "local-user" },
        credentialContext: {
          actor: { type: "user", userId: "local-user" },
        },
        destination,
        source: createLocalSource(parentConversationId),
      } satisfies AgentRun;
      const spawnAgent = bindSpawnAgent(request, {
        conversationStore,
        queue,
      });
      expect(spawnAgent).toBeDefined();
      const tool = createSpawnAgentTool(spawnAgent!, {
        activeProfile: () => "standard",
        defaultProfile: "standard",
        profiles: {
          standard: { modelId: "test/standard" },
          handoff: {
            modelId: "test/handoff",
            description: "Implementation work.",
          },
        },
      });
      const input = tool.prepareArguments!({
        task: "Inspect the failing checks.",
        title: "Failing checks",
        name: "reviewer",
        reasoning_level: "high",
        profile: "handoff",
      });

      const first = await tool.execute!(input, { toolCallId: "call-1" });
      const replay = await tool.execute!(input, { toolCallId: "call-1" });

      expect(replay).toEqual(first);
      await expect(
        getAgentInvocation(
          getAgentInvocationId(parentConversationId, "parent-turn:call-1"),
        ),
      ).resolves.toMatchObject({
        childConversationId: first.conversation_id,
        actor: { platform: "local", userId: "local-user" },
        agentName: "reviewer",
        credentialContext: {
          actor: { type: "user", userId: "local-user" },
        },
        destination,
        input: "Inspect the failing checks.",
        parentConversationId,
        modelProfile: "handoff",
        reasoningLevel: "high",
        title: "Failing checks",
      });
      expect(queue.sentRecords()).toHaveLength(1);
      // The parent log gets one dashboard marker for the replayed tool call.
      await expect(loadSubagentEvents(parentConversationId)).resolves.toEqual([
        {
          type: "subagent_started",
          subagentInvocationId: getAgentInvocationId(
            parentConversationId,
            "parent-turn:call-1",
          ),
          subagentKind: "agent",
          childConversationId: first.conversation_id,
          agentName: "reviewer",
          parentToolCallId: "call-1",
          task: "Inspect the failing checks.",
          title: "Failing checks",
          reasoningLevel: "high",
        },
      ]);
      await expect(
        tool.execute!(
          tool.prepareArguments!({
            task: "Start overlapping work.",
            name: "reviewer",
            reasoning_level: "high",
          }),
          { toolCallId: "call-2" },
        ),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message:
          'A child agent named "reviewer" already exists. Use messageAgent to give it more work, or choose a different name.',
      });
    } finally {
      await fixture.close();
    }
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
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
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
      const helperContinuation = await sendToChild(grandResult);
      expect(helperContinuation).toMatchObject({
        actor: slackInvocationInput.actor,
        childConversationId: helper.childConversationId,
        input: expect.stringContaining("Grand helper fact: 42."),
        parentConversationId: child.childConversationId,
        status: "pending",
      });

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

  it("repairs the durable creation-to-mailbox crash gap once", async () => {
    const { fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "mailbox-repair-1",
          parentToolCallId: "call-repair",
        },
        2_000,
      );

      await recoverPendingAgentInvocationMailboxAppends({
        conversationWorkQueue: queue,
        nowMs: 3_000,
      });
      await recoverPendingAgentInvocationMailboxAppends({
        conversationWorkQueue: queue,
        nowMs: 4_000,
      });

      expect(queue.sentRecords()).toHaveLength(1);
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ mailboxStatus: "appended" });
      // The repair keeps the stored tool call, so the dashboard still pairs
      // the child row with its `spawnAgent` call.
      await expect(loadSubagentEvents(parentConversationId)).resolves.toEqual([
        expect.objectContaining({
          type: "subagent_started",
          subagentInvocationId: created.invocationId,
          parentToolCallId: "call-repair",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("repairs a terminal result that never reached its parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...slackInvocationInput,
          idempotencyKey: "parent-result-repair-1",
        },
        2_000,
      );
      // A sibling that the same parent started is still running.
      await createAgentInvocation(
        {
          ...slackInvocationInput,
          agentName: "scout",
          idempotencyKey: "parent-result-repair-sibling",
        },
        2_500,
      );
      // The worker stopped after the terminal write and before the parent append.
      await completeAgentInvocation({
        errorMessage: "GitHub authorization is required",
        invocationId: created.invocationId,
        status: "blocked",
      });
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "pending" });

      await recoverPendingAgentInvocationResults({
        conversationWorkQueue: queue,
        nowMs: Date.now(),
      });
      await recoverPendingAgentInvocationResults({
        conversationWorkQueue: queue,
        nowMs: Date.now(),
      });

      expect(
        queue
          .sentRecords()
          .filter(
            (record) => record.conversationId === slackParentConversationId,
          ),
      ).toHaveLength(1);
      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "appended" });
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            created.invocationId,
          ),
          source: "event",
        }),
      ]);
      expect(parentWork?.messages[0]?.input.text).toContain(
        "GitHub authorization is required",
      );
      // The parent can wait for the open sibling instead of reporting early.
      expect(parentWork?.messages[0]?.input.text).toContain('"scout"');
      await expect(
        loadSubagentEvents(slackParentConversationId),
      ).resolves.toEqual([
        {
          type: "subagent_ended",
          subagentInvocationId: created.invocationId,
          outcome: "blocked",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
  it("delivers a child's Message cards with the parent's result reply and shows its annotations on the root", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const events = getConversationEventStore();
    const lifecycle = new ConversationTurnLifecycleService(events);
    const change: ObjectAnnotation = {
      kind: "object",
      objectType: "code_change",
      key: "getsentry/junior#1",
      label: "getsentry/junior#1",
      title: "Fix the parser",
      url: "https://github.com/getsentry/junior/pull/1",
      status: "open",
    };
    try {
      const created = await createAgentInvocation(
        { ...slackInvocationInput, idempotencyKey: "open-change" },
        2_000,
      );
      const child = created.childConversationId;
      const childTurnId = getAgentInvocationTurnId(created.invocationId);
      // The child's Turn selects a card, as a plugin tool result does.
      await lifecycle.start({
        conversationId: child,
        createdAtMs: 2_000,
        inputMessageIds: [getAgentInvocationMessageId(created.invocationId)],
        surface: "internal",
        turnId: childTurnId,
      });
      const objectCards = await saveObjectAnnotations(child, "github", [
        change,
      ]);
      await events.append(child, [
        {
          createdAtMs: 2_001,
          data: {
            type: "tool_result",
            toolName: "github_createPullRequest",
            details: { objectCards },
            isError: false,
          },
        },
      ]);
      await lifecycle.complete({
        conversationId: child,
        createdAtMs: 2_002,
        outcome: "success",
        turnId: childTurnId,
      });
      const terminal = await completeAgentInvocation({
        invocationId: created.invocationId,
        result: "Opened getsentry/junior#1.",
        status: "completed",
      });
      await enqueueAgentInvocationResult(terminal as TerminalAgentInvocation, {
        queue,
        state,
      });

      // The result starts a parent Turn. Its reply delivers the child's card.
      await lifecycle.start({
        conversationId: slackParentConversationId,
        createdAtMs: 40_000,
        inputMessageIds: [
          getAgentInvocationResultMessageId(created.invocationId),
        ],
        surface: "slack",
        turnId: "parent-result-turn",
      });
      await expect(
        loadPendingMessageCards(slackParentConversationId),
      ).resolves.toEqual([{ ...change, plugin: "github" }]);
      await expect(
        listConversationAnnotations(getDb(), slackParentConversationId),
      ).resolves.toMatchObject([{ plugin: "github", key: change.key }]);
      const feed = await readConversationFeedFromSql();
      expect(
        feed.conversations.find(
          (item) => item.conversationId === slackParentConversationId,
        )?.annotations,
      ).toMatchObject([{ plugin: "github", key: change.key }]);
    } finally {
      await fixture.close();
    }
  });

  it("names a finished sibling whose result has not reached the parent", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const first = await createAgentInvocation(
        { ...slackInvocationInput, idempotencyKey: "fan-out-first" },
        2_000,
      );
      const sibling = await createAgentInvocation(
        {
          ...slackInvocationInput,
          agentName: "analyst",
          idempotencyKey: "fan-out-sibling",
        },
        2_500,
      );
      // Both children finish before either result reaches the parent.
      const result = await completeAgentInvocation({
        invocationId: first.invocationId,
        result: "First finding.",
        status: "completed",
      });
      await completeAgentInvocation({
        invocationId: sibling.invocationId,
        result: "Second finding.",
        status: "completed",
      });

      await enqueueAgentInvocationResult(result as TerminalAgentInvocation, {
        queue,
        state,
      });

      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages[0]?.input.text).toContain(
        'have not reported yet: "analyst"',
      );
    } finally {
      await fixture.close();
    }
  });
});
