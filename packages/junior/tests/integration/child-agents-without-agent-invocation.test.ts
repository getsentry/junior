import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
  MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT,
} from "@/chat/agent-invocations/create";
import {
  AgentInvocationLimitError,
  AgentMessageQueueFullError,
} from "@/chat/agent-invocations/errors";
import { FORK_INSTRUCTIONS } from "@/chat/agent-invocations/fork-history";
import { getAgentInvocationIdForMessage } from "@/chat/agent-invocations/ids";
import { listUnreportedSiblingAgents } from "@/chat/agent-invocations/list";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import {
  createDeliverToParent,
  enqueueAgentInvocationResult,
} from "@/chat/agent-invocations/result";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import {
  completeAgentInvocation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { getConversationEventStore } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import {
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  sendParentMessage,
  spawnChildWithoutAgentInvocation,
} from "../fixtures/child-without-agent-invocation";
import { webTestActor } from "../fixtures/conversation";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import { createHarness, type Harness } from "../fixtures/thread-input";

async function parentMessageTexts() {
  return (
    (
      await getConversationWorkState({
        conversationId: slackParentConversationId,
      })
    )?.messages.map((message) => message.input.text) ?? []
  );
}

describe("child agents that no Agent invocation names", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  async function spawnChild(
    harness: Harness,
    idempotencyKey: string,
    input: Partial<Parameters<typeof spawnChildWithoutAgentInvocation>[0]> = {},
  ) {
    return await spawnChildWithoutAgentInvocation({
      actor: slackInvocationInput.actor,
      conversationStore: harness.conversationStore,
      idempotencyKey,
      parentConversationId: slackParentConversationId,
      queue: harness.queue,
      state: harness.state,
      ...input,
    });
  }

  it("runs a parent task as the parent Turn's Actor, grants, and spawn options", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      // The timer's Watch belongs to the parent, whose Turn spawned the child.
      const credentialContext = {
        actor: EVENT_SYSTEM_ACTOR,
        subject: bindTimerWatchCredentialSubject({
          conversationId: slackParentConversationId,
          userId: webTestActor.userId,
          watchId: "watch-1",
        })!,
      };
      const childId = await spawnChild(harness, "timer-turn:call-1", {
        actor: EVENT_SYSTEM_ACTOR,
        credentialContext,
        spawnOptions: { reasoningLevel: "high" },
      });
      await harness.processUntilRun(childId);

      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: childId,
        credentialContext,
        instruction: { provenance: { authority: "instruction" } },
        reasoning: "high",
      });
      expect(run.agentInvocationId).toBeUndefined();
      expect(run.instruction.text).toContain("Check the deploy.");
    } finally {
      await harness.close();
    }
  });

  it("delivers the child's reply to its parent as the child's Actor", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: slackInvocationInput.actor,
        conversationId: childId,
        result: {
          kind: "reply",
          reply: { text: "Deploy is green.", toolCallId: "call-reply" },
        },
        turnId: "turn_child",
      });
      vi.setSystemTime(Date.now() + 60_000);
      await harness.processUntilRun(slackParentConversationId);

      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        actor: slackInvocationInput.actor,
        conversationId: slackParentConversationId,
      });
      expect(run.instruction.text).toContain("Deploy is green.");
    } finally {
      await harness.close();
    }
  });

  it("drops the child's unread reply when its parent stops it", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      await harness.processUntilRun(childId);
      await harness.drain(childId);
      const before = await parentMessageTexts();
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: slackInvocationInput.actor,
        conversationId: childId,
        result: {
          kind: "reply",
          reply: { text: "Deploy is green.", toolCallId: "call-reply" },
        },
        turnId: "turn_child",
      });
      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });

      await expect(parentMessageTexts()).resolves.toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("shows the child's status from its mailbox and Turns", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        title: "Deploy check",
      });
      const searchAgents = createSearchAgentsTool({
        conversationId: slackParentConversationId,
      });

      // The task waits in the child's mailbox.
      await expect(searchAgents.execute!({}, {})).resolves.toEqual({
        agents: [
          expect.objectContaining({
            conversation_id: childId,
            status: "running",
          }),
        ],
      });
      await expect(
        listUnreportedSiblingAgents(
          slackParentConversationId,
          "agent:sibling",
          [],
        ),
      ).resolves.toEqual([
        expect.objectContaining({ childConversationId: childId }),
      ]);

      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });
      await expect(searchAgents.execute!({}, {})).resolves.toEqual({
        agents: [expect.objectContaining({ status: "stopped" })],
      });
    } finally {
      await harness.close();
    }
  });

  it("counts children with open tasks against the parent's limit", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      for (
        let index = 0;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        await spawnChild(harness, `parent-turn:call-${index}`);
      }

      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "parent-turn:call-over",
        }),
      ).rejects.toBeInstanceOf(AgentInvocationLimitError);
    } finally {
      await harness.close();
    }
  });

  it("gives a parent message to the child with its spawn options", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        spawnOptions: { agentType: "explore", reasoningLevel: "high" },
      });
      // The child finished its task and has no open work.
      await harness.processUntilRun(childId);
      await harness.drain(childId);

      const { invocation } = await createAgentInvocationForMessage({
        actor: slackInvocationInput.actor,
        childConversationId: childId,
        destination: slackInvocationInput.destination,
        idempotencyKey: "parent-turn:call-2",
        input: "Check it again.",
        parentConversationId: slackParentConversationId,
        parentToolCallId: "call-2",
      });

      expect(invocation).toMatchObject({
        agentType: "explore",
        childConversationId: childId,
        reasoningLevel: "high",
      });
    } finally {
      await harness.close();
    }
  });

  it("sends the child's messageAgent to its parent", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      const messageAgent = bindMessageAgent(
        {
          actor: slackInvocationInput.actor,
          conversationId: childId,
          destination: slackInvocationInput.destination,
          instruction: { text: "Check the deploy." },
          source: { kind: "agent_invocation" },
          turnId: "turn_child",
        },
        { queue: harness.queue, state: harness.state },
      )!;
      await messageAgent(
        { text: "Halfway done.", to: "parent" },
        { toolCallId: "call-message" },
      );

      await expect(parentMessageTexts()).resolves.toContainEqual(
        expect.stringContaining("Halfway done."),
      );
    } finally {
      await harness.close();
    }
  });

  it("labels a parent task as the instruction that Guardian reads", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      await harness.processUntilRun(childId);

      // An agent writes the child's instructions, so Guardian reads no actor.
      const root = await readRootConversation({
        actor: undefined,
        conversationId: childId,
      });
      expect(root.messages).toContainEqual({
        author: "user",
        text: expect.stringContaining("Check the deploy."),
      });
    } finally {
      await harness.close();
    }
  });

  it("starts a fork with its parent's history", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      await getConversationEventStore().append(slackParentConversationId, [
        {
          data: historyItemFromPiMessage(
            {
              role: "user",
              content: [{ type: "text", text: "Parent context." }],
              timestamp: 1,
            },
            { authority: "instruction" },
          ),
          createdAtMs: 1,
        },
      ]);
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        spawnOptions: { fork: true },
      });
      await harness.processUntilRun(childId);

      const run = harness.runs.at(-1)!;
      expect(JSON.stringify(run.history)).toContain("Parent context.");
      expect(run.instruction.text).toContain(FORK_INSTRUCTIONS);
    } finally {
      await harness.close();
    }
  });

  it("drops a parent message that names another parent", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        from: "slack:C999:1712345.0009",
        spawnOptions: { fork: true },
      });
      await harness.drain(childId);

      expect(harness.runs).toEqual([]);
      await expect(
        getConversationWorkState({ conversationId: childId }),
      ).resolves.toMatchObject({ messages: [] });
    } finally {
      await harness.close();
    }
  });

  it("queues a parent message behind a child's open Agent invocation", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const { childConversationId: childId } = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "open-row",
      });
      const inboundMessageId = await sendParentMessage({
        actor: slackInvocationInput.actor,
        childConversationId: childId,
        idempotencyKey: "parent-turn:call-2",
        parentConversationId: slackParentConversationId,
        queue: harness.queue,
        state: harness.state,
        text: "Check it again.",
      });
      await harness.drain(childId);

      await expect(
        getAgentInvocation(getAgentInvocationIdForMessage(inboundMessageId)),
      ).resolves.toMatchObject({
        actor: slackInvocationInput.actor,
        childConversationId: childId,
        input: "Check it again.",
        parentToolCallId: "parent-turn:call-2",
      });
      expect(harness.runs.every((run) => run.agentInvocationId)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("keeps a child's result while its grandchild has open work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const open = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "open-row",
      });
      await spawnChild(harness, "child-turn:call-1", {
        parentConversationId: open.childConversationId,
      });

      await expect(
        completeAgentInvocation({
          invocationId: open.invocationId,
          result: "Done.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
    } finally {
      await harness.close();
    }
  });

  it("keeps a child's result as on main when only a grandchild with a row replied", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const open = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "open-row",
      });
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "helper",
        parentConversationId: open.childConversationId,
      });
      await completeAgentInvocation({
        invocationId: helper.invocationId,
        result: "",
        status: "completed",
      });
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: slackInvocationInput.actor,
        conversationId: helper.childConversationId,
        result: {
          kind: "reply",
          reply: { text: "Helper fact.", toolCallId: "call-reply" },
        },
        turnId: "turn_helper",
      });

      await expect(
        completeAgentInvocation({
          invocationId: open.invocationId,
          result: "Done.",
          status: "completed",
        }),
      ).resolves.toMatchObject({ parentMailboxStatus: "pending" });
    } finally {
      await harness.close();
    }
  });

  it("keeps a child's result while its grandchild's Turn yields", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const open = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "open-row",
      });
      const grandchildId = await spawnChild(harness, "child-turn:call-1", {
        parentConversationId: open.childConversationId,
      });
      await completeAgentInvocation({
        invocationId: open.invocationId,
        result: "Done.",
        status: "completed",
      });
      // The grandchild's Turn takes its input and yields between slices.
      // This fake runner saves no slice, so only the Turn's end status
      // holds the child's result back.
      harness.onPersonRun(async (run) => {
        await run.durability?.onInputCommitted?.();
        return { reason: "yield", resumeVersion: 1, status: "suspended" };
      });
      await harness.processUntilRun(grandchildId);

      await expect(
        getAgentInvocation(open.invocationId),
      ).resolves.toMatchObject({ parentMailboxStatus: "replaced" });
    } finally {
      await harness.close();
    }
  });

  it("resumes a parent task as the instruction that Guardian reads", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      // The first attempt takes its input and saves a slice. The retry
      // resumes that Turn.
      harness.onPersonRun(async (run) => {
        if (harness.runs.length === 1) {
          await run.durability?.onInputCommitted?.();
          await saveTurnCheckpoint({
            actor: run.actor!,
            conversationId: childId,
            destination: undefined,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Check the deploy." }],
                timestamp: 1,
              },
            ],
            mode: "paused",
            reason: "yield",
            sliceId: 1,
            source: run.source!,
            surface: "api",
            turnId: run.turnId!,
          });
        }
        throw new Error("stop after reading the run");
      });
      await harness.processUntilRun(childId);
      await harness.processUntilRun(childId);

      const [first, resumed] = harness.runs;
      expect(resumed).toMatchObject({
        conversationId: childId,
        instruction: { provenance: { authority: "instruction" } },
        turnId: first!.turnId,
      });
      await expect(
        readRootConversation({ actor: undefined, conversationId: childId }),
      ).resolves.toMatchObject({
        messages: expect.arrayContaining([
          {
            author: "user",
            text: expect.stringContaining("Check the deploy."),
          },
        ]),
      });
    } finally {
      await harness.close();
    }
  });

  it("drops a parent message with another author id", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1", {
        authorId: "agent-invocation:slack:T123:U123",
      });
      await harness.drain(childId);

      expect(harness.runs).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("refuses an ancestor's timer grant on input that is not a parent message", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
        await harness.drain(childId);
        await runHeartbeatAfterLeasesExpire(harness.queue);
      }
      // The grandchild's grants name a timer Watch of the child's parent.
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        actor: EVENT_SYSTEM_ACTOR,
        credentialContext: {
          actor: EVENT_SYSTEM_ACTOR,
          subject: bindTimerWatchCredentialSubject({
            conversationId: slackParentConversationId,
            userId: webTestActor.userId,
            watchId: "watch-1",
          })!,
        },
        idempotencyKey: "helper",
        parentConversationId: childId,
      });
      await enqueueAgentInvocationResult(
        (await completeAgentInvocation({
          errorMessage: "Needs a token.",
          invocationId: helper.invocationId,
          status: "blocked",
        })) as TerminalAgentInvocation,
        { queue: harness.queue, state: harness.state },
      );
      const runCount = harness.runs.length;
      // The result waits out its batch window.
      await runHeartbeatAfterLeasesExpire(harness.queue);
      await harness.processUntilRun(childId);

      expect(harness.runs.length).toBe(runCount + 1);
      expect(harness.runs.at(-1)).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: childId,
        credentialContext: { actor: EVENT_SYSTEM_ACTOR },
      });
      expect(harness.runs.at(-1)!.credentialContext).not.toHaveProperty(
        "subject",
      );
    } finally {
      await harness.close();
    }
  });

  it("caps the open parent messages of one child", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-0");
      for (let index = 1; index < 4; index++) {
        await sendParentMessage({
          actor: slackInvocationInput.actor,
          childConversationId: childId,
          idempotencyKey: `parent-turn:call-${index}`,
          parentConversationId: slackParentConversationId,
          queue: harness.queue,
          state: harness.state,
        });
      }

      await expect(
        createAgentInvocationForMessage({
          actor: slackInvocationInput.actor,
          childConversationId: childId,
          destination: slackInvocationInput.destination,
          idempotencyKey: "parent-turn:call-over",
          input: "Check it again.",
          parentConversationId: slackParentConversationId,
          parentToolCallId: "call-over",
        }),
      ).rejects.toBeInstanceOf(AgentMessageQueueFullError);
    } finally {
      await harness.close();
    }
  });

  it("gives no work to child agents while the child is stopped", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawnChild(harness, "parent-turn:call-1");
      await markConversationsStopped([childId], {
        cancelWatches: false,
        state: harness.state,
      });

      await expect(
        createAgentInvocation({
          ...slackInvocationInput,
          idempotencyKey: "child-turn:call-1",
          parentConversationId: childId,
        }),
      ).rejects.toThrow("is stopped");
    } finally {
      await harness.close();
    }
  });
});
