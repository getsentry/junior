import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import {
  getAgentInvocationId,
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
  getAgentReplyMessageId,
} from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getAgentInvocation,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import {
  enqueueAgentInvocationResult,
  enqueueAgentReplyToParent,
} from "@/chat/agent-invocations/result";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import { getConversationWorkState } from "@/chat/task-execution/store";
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
import { juniorConversations } from "@/db/schema";
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
      // A child stores its parent's Destination row, like every Conversation.
      expect(child?.destination).toEqual(invocationInput.destination);
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
      const tool = createSpawnAgentTool(spawnAgent!, { owner: "none" });
      const input = tool.prepareArguments!({
        task: "Inspect the failing checks.",
        title: "Failing checks",
        name: "reviewer",
        reasoning_level: "high",
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

  it("refuses a spawn past maxAgentDepth or from a chain with no root", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    try {
      const child = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "depth-child",
      });
      const grandchild = await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: "depth-grandchild",
        parentConversationId: child.childConversationId,
      });
      const spawnFrom = (conversationId: string, toolCallId: string) => {
        const spawnAgent = bindSpawnAgent(
          {
            conversationId,
            turnId: "parent-turn",
            instruction: { text: "Delegate the investigation." },
            actor: { platform: "local", userId: "local-user" },
            credentialContext: {
              actor: { type: "user", userId: "local-user" },
            },
            destination,
            source: createLocalSource(parentConversationId),
          },
          { conversationStore, maxAgentDepth: 1, queue },
        );
        const tool = createSpawnAgentTool(spawnAgent!, { owner: "none" });
        return tool.execute!(
          tool.prepareArguments!({
            task: "Inspect the failing checks.",
            title: "Failing checks",
          }),
          { toolCallId },
        );
      };
      const refusal = {
        name: "ToolInputError",
        message:
          "This agent cannot start child agents: only 1 level(s) of child agents can start their own. Do the work in this agent instead.",
      };

      // With maxAgentDepth 1, a child of the root can spawn and its own
      // child cannot.
      await expect(
        spawnFrom(child.childConversationId, "call-child"),
      ).resolves.toMatchObject({ conversation_id: expect.any(String) });
      await expect(
        spawnFrom(grandchild.childConversationId, "call-grandchild"),
      ).rejects.toMatchObject(refusal);

      // Bad data: no writer can link a root to its own descendant. The chain
      // then has no root, so no Conversation in it can spawn.
      await getDb()
        .update(juniorConversations)
        .set({
          kind: "task",
          parentConversationId: grandchild.childConversationId,
        })
        .where(eq(juniorConversations.conversationId, parentConversationId));
      await expect(
        spawnFrom(child.childConversationId, "call-cycle"),
      ).rejects.toMatchObject(refusal);
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
      // The sibling finishes before the first child's reply reaches the
      // parent.
      await completeAgentInvocation({
        invocationId: sibling.invocationId,
        errorMessage: "Needs the repo name.",
        status: "blocked",
      });

      await enqueueAgentReplyToParent({
        queue,
        reply: { text: "First finding.", toolCallId: "call-reply" },
        sender: first,
        state,
      });

      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages[0]?.input.text).toContain(
        ' waiting_on="analyst"',
      );
    } finally {
      await fixture.close();
    }
  });

  it("does not wait for a running sibling that already replied", async () => {
    const { fixture } = await prepareSlackParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const replied = await createAgentInvocation(
        {
          ...slackInvocationInput,
          agentName: "analyst",
          idempotencyKey: "fan-out-replied",
        },
        2_000,
      );
      const other = await createAgentInvocation(
        { ...slackInvocationInput, idempotencyKey: "fan-out-other" },
        2_500,
      );
      await markAgentInvocationRunning(replied.invocationId);
      await enqueueAgentReplyToParent({
        queue,
        reply: { text: "First finding.", toolCallId: "call-reply" },
        sender: replied,
        state,
      });
      // The other child finishes while the replied child's row still runs.
      const terminal = await completeAgentInvocation({
        invocationId: other.invocationId,
        errorMessage: "model unavailable",
        status: "failed",
      });
      await enqueueAgentInvocationResult(terminal as TerminalAgentInvocation, {
        queue,
        state,
      });

      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(
        parentWork?.messages.map((message) => message.inboundMessageId),
      ).toEqual([
        getAgentReplyMessageId(replied.invocationId, "call-reply"),
        getAgentInvocationResultMessageId(other.invocationId),
      ]);
      expect(parentWork?.messages[1]?.input.text).not.toContain("waiting_on");
    } finally {
      await fixture.close();
    }
  });
});
