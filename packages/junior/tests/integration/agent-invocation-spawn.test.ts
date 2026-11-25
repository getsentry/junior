import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnChildAgent as spawnChild } from "@/chat/agent-invocations/create";
import { AgentNameInUseError } from "@/chat/agent-invocations/errors";
import {
  getAgentReplyMessageId,
  getParentMessageId,
} from "@/chat/agent-invocations/ids";
import { createDeliverToParent } from "@/chat/agent-invocations/result";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { createEventInboundMessage } from "@/chat/events/notification";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { openConversationProjection } from "@/chat/conversations/projection";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { createStartAgentTool } from "@/chat/tools/runtime/start-agent";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  createEventSource,
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
  parentConversationId,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  spawnChildAgent,
} from "../fixtures/agent-invocations";
import { createHarness, finishRun } from "../fixtures/thread-input";

/** Connect the shared state adapter and a queue for one Slack parent. */
async function prepareSlackParent() {
  const { conversationStore, fixture } = await prepareSlackParentConversation();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  const spawn = async (idempotencyKey: string, agentName?: string) =>
    (
      await spawnChild(
        {
          ...slackInvocationInput,
          ...(agentName ? { agentName } : undefined),
          idempotencyKey,
          parentToolCallId: idempotencyKey,
          parentTurnId: idempotencyKey,
        },
        { conversationStore, queue, state },
      )
    ).childConversationId;
  return { conversationStore, fixture, queue, spawn, state };
}

/** The Turn id of a child's task Turn, which its parent message names. */
function taskTurnId(idempotencyKey: string): string {
  return buildDeterministicTurnId(
    getParentMessageId(slackParentConversationId, idempotencyKey),
  );
}

async function parentMessages(
  state: Awaited<ReturnType<typeof prepareSlackParent>>["state"],
) {
  return (
    (
      await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      })
    )?.messages ?? []
  );
}

describe("child agent spawn and result delivery", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("keeps each name to one child and stores the child below its parent", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    const spawn = async (idempotencyKey: string, agentName?: string) =>
      (
        await bindSpawnAgent(
          {
            actor: slackInvocationInput.actor,
            conversationId: slackParentConversationId,
            destination: slackDestination,
            instruction: { text: "Delegate the investigation." },
            source: createLocalSource(slackParentConversationId),
            turnId: "parent-turn",
          },
          {
            conversationStore: harness.conversationStore,
            queue: harness.queue,
            state: harness.state,
          },
        )!(
          {
            ...(agentName ? { name: agentName } : undefined),
            task: "Check the deploy.",
          },
          { toolCallId: idempotencyKey },
        )
      ).childConversationId;
    try {
      const named = await spawn("named-1", harness.agentName);
      // The child finished its task.
      harness.onRun(finishRun);
      await harness.drain(named);

      // A finished child keeps its name. A new task for it is a message.
      await expect(spawn("named-2", harness.agentName)).rejects.toBeInstanceOf(
        AgentNameInUseError,
      );
      // A replay of the first task still returns it after it finished.
      await expect(spawn("named-1", harness.agentName)).resolves.toBe(named);
      const unnamed = await spawn("unnamed-1");
      await expect(spawn("unnamed-1")).resolves.toBe(unnamed);
      await expect(spawn("unnamed-2")).resolves.not.toBe(unnamed);

      const child = await harness.conversationStore.get({
        conversationId: named,
      });
      expect(child).toMatchObject({
        parentConversationId: slackParentConversationId,
        source: "internal",
      });
      // A child stores its parent's Destination row, like every Conversation.
      expect(child?.destination).toEqual(slackDestination);
    } finally {
      await harness.close();
    }
  });

  it("refuses a spawn past maxAgentDepth or from a chain with no root", async () => {
    const { conversationStore, fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const child = await spawnChildAgent({
        conversationStore,
        idempotencyKey: "depth-child",
        parentConversationId,
        queue,
        state,
      });
      const grandchild = await spawnChildAgent({
        conversationStore,
        idempotencyKey: "depth-grandchild",
        parentConversationId: child.childConversationId,
        queue,
        state,
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
          { conversationStore, maxAgentDepth: 1, queue, state },
        );
        const tool = createStartAgentTool(spawnAgent!, { owner: "none" });
        return tool.execute!(
          tool.prepareArguments({
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
          visibility: null,
        })
        .where(eq(juniorConversations.conversationId, parentConversationId));
      await expect(
        spawnFrom(child.childConversationId, "call-cycle"),
      ).rejects.toMatchObject(refusal);
    } finally {
      await fixture.close();
    }
  });

  it("delivers the cards of the child Turn that replied with the parent's reply and shows them on the root", async () => {
    const { fixture, queue, spawn, state } = await prepareSlackParent();
    const events = getConversationEventStore();
    const lifecycle = new ConversationTurnLifecycleService(events, {
      watchQueue: createConversationWorkQueueTestAdapter,
    });
    const change = (key: string): ObjectAnnotation => ({
      kind: "object",
      objectType: "code_change",
      key,
      label: key,
      title: "Fix the parser",
      url: "https://github.com/getsentry/junior/pull/1",
      status: "open",
    });
    try {
      const childId = await spawn("loop-cards");
      // One Turn of the child selects the card of one change, as a plugin
      // tool result does.
      const runTurn = async (turnId: string, key: string, atMs: number) => {
        await lifecycle.start({
          conversationId: childId,
          createdAtMs: atMs,
          inputMessageIds: [`input:${turnId}`],
          surface: "internal",
          turnId,
        });
        await events.append(childId, [
          {
            createdAtMs: atMs + 1,
            data: {
              type: "tool_result",
              toolName: "github_createPullRequest",
              details: {
                objectCards: await saveObjectAnnotations(childId, "github", [
                  change(key),
                ]),
              },
              isError: false,
            },
          },
        ]);
      };
      const taskTurn = taskTurnId("loop-cards");
      await runTurn(taskTurn, "getsentry/junior#1", 2_000);
      await lifecycle.complete({
        conversationId: childId,
        createdAtMs: 2_010,
        outcome: "success",
        turnId: taskTurn,
      });
      // A Watch Event Turn of the child replies before it ends.
      await runTurn("turn_watch-event", "getsentry/junior#2", 3_000);
      await createDeliverToParent({ queue, state })({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: childId,
        result: {
          kind: "completed",
          text: "Opened #2.",
        },
        turnId: "turn_watch-event",
      });

      // The `reply` starts a parent Turn. Its reply delivers the card of the
      // child Turn that replied, not of the task's Turn.
      await lifecycle.start({
        conversationId: slackParentConversationId,
        createdAtMs: 40_000,
        inputMessageIds: [getAgentReplyMessageId(childId, "turn_watch-event")],
        surface: "slack",
        turnId: "parent-loop-reply-turn",
      });
      await expect(
        loadPendingMessageCards(slackParentConversationId),
      ).resolves.toEqual([
        { ...change("getsentry/junior#2"), plugin: "github" },
      ]);
      // The root shows the annotations of every child below it.
      const keys = ["getsentry/junior#1", "getsentry/junior#2"];
      expect(
        (await listConversationAnnotations(getDb(), slackParentConversationId))
          .map((annotation) => annotation.key)
          .sort(),
      ).toEqual(keys);
      const feed = await readConversationFeedFromSql();
      expect(
        feed.conversations
          .find((item) => item.conversationId === slackParentConversationId)
          ?.sidebarAnnotations?.map((annotation) => annotation.key)
          .sort(),
      ).toEqual(keys);
    } finally {
      await fixture.close();
    }
  });

  it("names a running sibling whose result has not reached the parent", async () => {
    const { fixture, queue, spawn, state } = await prepareSlackParent();
    try {
      const first = await spawn("fan-out-first");
      // The sibling's task still waits, so it still runs.
      await spawn("fan-out-sibling", "analyst");
      await createDeliverToParent({ queue, state })({
        actor: slackInvocationInput.actor,
        conversationId: first,
        result: {
          kind: "completed",
          text: "First finding.",
        },
        turnId: taskTurnId("fan-out-first"),
      });

      const [result] = await parentMessages(state);
      expect(result?.input.text).toContain(' waiting_on="analyst"');
    } finally {
      await fixture.close();
    }
  });

  // A running sibling has answered once the reply of its open Turn is in the
  // parent's mailbox. Before its first checkpoint, the Turn still holds its
  // input in the mailbox.
  it.each([
    "after its first checkpoint",
    "before its first checkpoint",
  ] as const)(
    "does not wait for a running sibling that already replied %s",
    async (when) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      const { queue, state } = harness;
      try {
        const replied = await spawnChild(
          {
            ...slackInvocationInput,
            agentName: "analyst",
            idempotencyKey: "fan-out-replied",
            parentToolCallId: "fan-out-replied",
            parentTurnId: "fan-out-replied",
          },
          harness,
        );
        const repliedId = replied.childConversationId;
        // The task's Turn ended. A Watch Event Turn of the child replied and
        // is still open.
        harness.onRun(finishRun);
        await harness.drain(repliedId);
        const event = createEventInboundMessage({
          event: {
            eventKey: "deploy-1",
            eventType: "deployment.failed",
            identifier: "getsentry/junior",
            namespace: "github",
            occurredAtMs: Date.now(),
            trustedSummary: "A deployment failed.",
          },
          subscription: { conversationId: repliedId, id: "watch-1" },
          text: "Deploy failed.",
        });
        const turnId = buildDeterministicTurnId(event.inboundMessageId);
        if (when === "after its first checkpoint") {
          // The Turn's prompt follows the child's committed history, such
          // as its parent's task.
          const history = (
            await openConversationProjection({ conversationId: repliedId })
          ).messages;
          await saveTurnCheckpoint({
            actor: EVENT_SYSTEM_ACTOR,
            conversationId: repliedId,
            destination: slackDestination,
            messages: [
              ...history,
              {
                role: "user",
                content: [{ type: "text", text: "Deploy failed." }],
                timestamp: Date.now(),
              },
            ],
            mode: "running",
            sliceId: 1,
            source: createEventSource({
              eventKey: "deploy-1",
              eventType: "deployment.failed",
              identifier: "getsentry/junior",
              namespace: "github",
            }),
            surface: "api",
            turnId,
          });
        } else {
          // An earlier input waits in another batch, so the Turn's input is
          // not the first pending one.
          await appendInboundMessage({
            message: {
              conversationId: repliedId,
              createdAtMs: Date.now() - 100,
              delivery: "defer",
              inboundMessageId: "web:replied-child:person",
              input: { text: "Any update?" },
              receivedAtMs: Date.now() - 100,
              source: "web",
            },
            state,
          });
          await appendAndEnqueueInboundMessage({
            message: event,
            queue,
            state,
          });
        }
        const deliver = createDeliverToParent({ queue, state });
        await deliver({
          actor: EVENT_SYSTEM_ACTOR,
          conversationId: repliedId,
          result: {
            kind: "completed",
            text: "First finding.",
          },
          turnId,
        });
        // The other child fails later, while the replied child still runs.
        vi.setSystemTime(Date.now() + 1_000);
        const other = await spawnChild(
          {
            ...slackInvocationInput,
            idempotencyKey: "fan-out-other",
            parentToolCallId: "fan-out-other",
            parentTurnId: "fan-out-other",
          },
          harness,
        );
        await deliver({
          actor: slackInvocationInput.actor,
          conversationId: other.childConversationId,
          result: { kind: "failed", text: "model unavailable" },
          turnId: "turn_other",
        });

        const messages = (await parentMessages(state)).slice(-2);
        expect(messages.map((message) => message.inboundMessageId)).toEqual([
          getAgentReplyMessageId(repliedId, turnId),
          getAgentReplyMessageId(other.childConversationId, "turn_other"),
        ]);
        expect(messages[1]?.input.text).toContain("model unavailable");
        expect(messages[1]?.input.text).not.toContain("waiting_on");
      } finally {
        await harness.close();
      }
    },
  );

  it("names a sibling that replies at the same moment in only one reply", async () => {
    const { fixture, queue, spawn, state } = await prepareSlackParent();
    try {
      const siblings = await Promise.all(
        ["analyst", "auditor"].map((agentName) =>
          spawn(`fan-out-${agentName}`, agentName),
        ),
      );
      // Both task Turns reply before either reply reaches the parent's
      // mailbox.
      await Promise.all(
        siblings.map((childId, index) =>
          createDeliverToParent({ queue, state })({
            actor: slackInvocationInput.actor,
            conversationId: childId,
            result: {
              kind: "completed",
              text: "Finding.",
            },
            turnId: taskTurnId(`fan-out-${["analyst", "auditor"][index]}`),
          }),
        ),
      );

      const texts = (await parentMessages(state)).map(
        (message) => message.input.text,
      );
      expect(texts).toHaveLength(2);
      // The first reply waits for the other sibling. The second sees the
      // first one's reply, so it waits for nobody.
      expect(texts.filter((text) => text.includes("waiting_on="))).toEqual([
        expect.stringMatching(/ waiting_on="(analyst|auditor)"/),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("makes a child private when its root's channel goes private", async () => {
    const { conversationStore, fixture, spawn } = await prepareSlackParent();
    try {
      const childId = await spawn("private-1");
      const childBefore = await conversationStore.get({
        conversationId: childId,
      });
      expect(childBefore).toMatchObject({ visibility: "public" });

      // Only the root records the new visibility. The child shares its
      // Destination row, so its own row does not change.
      await conversationStore.recordActivity({
        conversationId: slackParentConversationId,
        destination: slackDestination,
        nowMs: 3_000,
        source: "slack",
        visibility: "private",
      });
      await expect(
        conversationStore.get({ conversationId: childId }),
      ).resolves.toEqual({ ...childBefore, visibility: "private" });
    } finally {
      await fixture.close();
    }
  });
});
