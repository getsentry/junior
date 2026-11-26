import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentBinding } from "@/chat/agent-invocations/bindings";
import { MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT } from "@/chat/agent-invocations/create";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
  AgentStoppedError,
} from "@/chat/agent-invocations/errors";
import { getParentMessageId } from "@/chat/agent-invocations/ids";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { readRootConversation } from "@/chat/agent-invocations/root-conversation";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { stopChildAgentsOf } from "@/chat/agent-invocations/stop";
import { stopConversationAndChildAgents } from "@/chat/conversations/stop";
import type { AgentRun } from "@/chat/agent/types";
import { readAgentConfig } from "@/chat/conversations/agent-config";
import { loadTurnConversationNotes } from "@/chat/conversations/notes";
import {
  getConversationStoppedAtMs,
  resumeConversationTree,
  stopConversationTree,
} from "@/chat/conversations/session-stop";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { createStartAgentTool } from "@/chat/tools/runtime/start-agent";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_WORK_MAX_RETRIES,
  stopConversationWork,
} from "@/chat/task-execution/store";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  loadSubagentEvents,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  createConversationWorkQueueTestAdapter,
  deferred,
  runHeartbeatAfterLeasesExpire,
} from "../fixtures/conversation-work";
import {
  mailboxTexts,
  message,
  parentRun,
  spawn,
} from "../fixtures/parent-agent-tools";
import { readProxyProperty } from "../fixtures/proxy-property";
import {
  createHarness,
  finishRun,
  sendPersonMessage,
} from "../fixtures/thread-input";

/** Record the start of a parent Turn, as the root Turn code does. */
async function startParentTurn(turnId = "parent-turn") {
  await new ConversationTurnLifecycleService(getConversationEventStore(), {
    watchQueue: createConversationWorkQueueTestAdapter,
  }).start({
    conversationId: slackParentConversationId,
    createdAtMs: Date.now(),
    inputMessageIds: [`${turnId}:input`],
    surface: "slack",
    turnId,
  });
}

describe("spawn and messageAgent", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("runs a spawned child's task as the parent Turn's Actor, grants, and agent config", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1", {
        kind: "thread",
        name: harness.agentName,
        reasoningLevel: "high",
        title: "Deploy check",
      });
      harness.onRun(finishRun);
      await harness.processUntilRun(childId);

      await expect(
        getAgentBinding({
          name: harness.agentName,
          parentConversationId: slackParentConversationId,
        }),
      ).resolves.toMatchObject({ childConversationId: childId });
      await expect(
        harness.conversationStore.get({ conversationId: childId }),
      ).resolves.toMatchObject({ kind: "thread", title: "Deploy check" });
      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        actor: slackInvocationInput.actor,
        conversationId: childId,
        credentialContext: parentRun().credentialContext,
        instruction: { provenance: { authority: "instruction" } },
        reasoning: "high",
      });
      expect(run.instruction.text).toContain("Check the deploy.");
      // A retry of the spawn writes no second marker.
      await spawn(harness, "call-1", {
        kind: "thread",
        name: harness.agentName,
        reasoningLevel: "high",
        title: "Deploy check",
      });
      const markerId = getParentMessageId(
        slackParentConversationId,
        "parent-turn:call-1",
      );
      await expect(
        loadSubagentEvents(slackParentConversationId),
      ).resolves.toEqual([
        {
          type: "subagent_started",
          subagentInvocationId: markerId,
          subagentKind: "agent",
          childConversationId: childId,
          agentName: harness.agentName,
          parentToolCallId: "call-1",
          task: "Check the deploy.",
          title: "Deploy check",
          reasoningLevel: "high",
        },
        {
          type: "subagent_ended",
          subagentInvocationId: markerId,
          outcome: "success",
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { change: "no name", input: { name: undefined } },
    { change: "another kind", input: { kind: "thread" as const } },
    { change: "another agent type", input: { agentType: "explore" as const } },
    { change: "a fork", input: { fork: true as const } },
    {
      change: "another reasoning level",
      input: { reasoningLevel: "low" as const },
    },
  ])("refuses a spawn replay with $change", async ({ input }) => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      await spawn(harness, "call-1", { name: harness.agentName });

      await expect(
        spawn(harness, "call-1", { name: harness.agentName, ...input }),
      ).rejects.toThrow("Spawn idempotency key was reused");
    } finally {
      await harness.close();
    }
  });

  it("keeps the first spawn's task, Actor, and grants on a replay", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const first = await spawn(harness, "call-1");

      await expect(
        bindSpawnAgent(
          {
            ...parentRun(),
            actor: EVENT_SYSTEM_ACTOR,
            credentialContext: { actor: EVENT_SYSTEM_ACTOR },
          },
          {
            conversationStore: harness.conversationStore,
            queue: harness.queue,
            state: harness.state,
          },
        )!({ task: "Check the rollback." }, { toolCallId: "call-1" }),
      ).resolves.toEqual({ childConversationId: first });
      harness.onRun(finishRun);
      await harness.processUntilRun(first);

      expect(harness.runs).toHaveLength(1);
      expect(harness.runs[0]).toMatchObject({
        actor: slackInvocationInput.actor,
        credentialContext: parentRun().credentialContext,
      });
      expect(harness.runs[0]!.instruction.text).toContain("Check the deploy.");
    } finally {
      await harness.close();
    }
  });

  it("replays a spawn by its idempotency key", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const first = await spawn(harness, "call-1", { name: harness.agentName });
      await expect(
        spawn(harness, "call-1", { name: harness.agentName }),
      ).resolves.toBe(first);

      await expect(mailboxTexts(harness, first)).resolves.toEqual([
        "Check the deploy.",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("drops a spawn's task when the spawn's SQL rolled back, and runs it on the retry", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      // The task reached the child's mailbox. Then the spawn's transaction
      // rolled back, so no child Conversation names this parent.
      let childId: string | undefined;
      await expect(
        getSqlExecutor().withLock("spawn-rolls-back", async () => {
          childId = await spawn(harness, "call-1");
          throw new Error("The spawn's transaction failed.");
        }),
      ).rejects.toThrow("The spawn's transaction failed.");
      await expect(mailboxTexts(harness, childId!)).resolves.toEqual([
        "Check the deploy.",
      ]);
      await expect(
        harness.conversationStore.get({ conversationId: childId! }),
      ).resolves.toBeUndefined();

      await harness.drain(childId!);

      expect(harness.runs).toEqual([]);
      await expect(mailboxTexts(harness, childId!)).resolves.toEqual([]);

      // The model retries the spawn. It creates the child, so the task runs.
      await expect(spawn(harness, "call-1")).resolves.toBe(childId);
      harness.onRun(finishRun);
      await harness.processUntilRun(childId!);
      expect(harness.runs).toHaveLength(1);
      expect(harness.runs[0]!.instruction.text).toContain("Check the deploy.");
    } finally {
      await harness.close();
    }
  });

  it("refuses a spawn whose name another child uses", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      await spawn(harness, "call-1", { name: harness.agentName });

      await expect(
        spawn(harness, "call-2", { name: harness.agentName }),
      ).rejects.toBeInstanceOf(AgentNameInUseError);
    } finally {
      await harness.close();
    }
  });

  it("counts a spawned child against the parent's limit before its spawn returns", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      for (
        let index = 1;
        index < MAX_ACTIVE_AGENT_INVOCATIONS_PER_PARENT;
        index++
      ) {
        await spawn(harness, `call-${index}`);
      }
      // The last free spawn waits to put its task in the child's mailbox.
      // Another spawn starts while it waits.
      const appending = deferred();
      const release = deferred();
      let waited = false;
      const slowMailbox = new Proxy(harness.state, {
        get(target, prop) {
          if (prop === "acquireLock") {
            return async (key: string, ttlMs: number) => {
              if (
                !waited &&
                key.startsWith("junior:conversation:v2:mutation:agent:")
              ) {
                waited = true;
                appending.resolve();
                await release.promise;
              }
              return await target.acquireLock(key, ttlMs);
            };
          }
          const value = readProxyProperty(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const last = spawn(harness, "call-last", {}, slowMailbox);
      await appending.promise;
      const over = spawn(harness, "call-over");
      await new Promise((resolve) => setTimeout(resolve, 250));
      release.resolve();

      // Settle both at once: the over-limit spawn can reject while the last
      // one still runs.
      const [lastResult, overResult] = await Promise.allSettled([last, over]);
      expect(lastResult).toEqual({
        status: "fulfilled",
        value: expect.any(String),
      });
      expect(overResult).toEqual({
        status: "rejected",
        reason: expect.any(AgentInvocationLimitError),
      });
    } finally {
      await harness.close();
    }
  });

  it.each(["task", "thread"] as const)(
    "tells a %s's parent when its Turn fails",
    async (kind) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await spawn(harness, "call-1", { kind });
        harness.onRun(async () => {
          throw new Error("The model is unavailable.");
        });
        // The runner throws on each try, so the last try fails the Turn.
        for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
          await harness.drain(childId);
          await runHeartbeatAfterLeasesExpire(harness.queue);
        }

        expect(
          (await mailboxTexts(harness, slackParentConversationId)).filter(
            (text) => text.includes('status="failed"'),
          ),
        ).toEqual([expect.stringContaining("The model is unavailable.")]);
        // The dashboard shows the failed work as failed, for both kinds.
        expect(
          (await loadSubagentEvents(slackParentConversationId)).filter(
            (event) => event.type === "subagent_ended",
          ),
        ).toEqual([expect.objectContaining({ outcome: "error" })]);
      } finally {
        await harness.close();
      }
    },
  );

  it("shows a child's Guardian only its parent's tasks as the user", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1", {
        name: harness.agentName,
        task: "List the published images.",
      });
      await harness.processUntilRun(childId);
      await message(harness, harness.agentName, "call-2");
      await harness.processUntilRun(childId);

      // An agent writes the child's instructions, so Guardian reads no actor.
      // A Turn records its input before it runs, so it reads its own task.
      // Each parent task and message counts as the user, and nothing else.
      const { messages } = await readRootConversation({
        actor: undefined,
        conversationId: childId,
      });
      expect(messages.map((entry) => entry.author)).toEqual(
        messages.map(() => "user"),
      );
      for (const task of ["List the published images.", "Check it again."]) {
        expect(messages.some((entry) => entry.text.includes(task))).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it("queues a parent message behind the child's waiting task and keeps its agent config", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1", {
        agentType: "explore",
      });
      vi.setSystemTime(1_800_000_001_000);
      // The task still waits, so the message waits behind it.
      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "queued",
      });
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([
        "Check the deploy.",
        "Check it again.",
      ]);
      await expect(readAgentConfig(childId)).resolves.toEqual({
        agentType: "explore",
      });
    } finally {
      await harness.close();
    }
  });

  it("ends a stopped child's stop when its parent sends it new work", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });
      vi.setSystemTime(1_800_000_001_000);

      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "started",
      });
      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        undefined,
      );
      // The stop skipped the task. It stays skipped.
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([
        "Check it again.",
      ]);
      await harness.processUntilRun(childId);
      expect(harness.runs).toHaveLength(1);
      expect(harness.runs[0]!.instruction.text).toContain("Check it again.");
    } finally {
      await harness.close();
    }
  });

  it("ends the markers of a stopped child's waiting tasks, and keeps the stop when a message replays", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await message(harness, childId, "call-2");
      await expect(mailboxTexts(harness, childId)).resolves.toHaveLength(2);
      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });

      // The stop drops both waiting tasks, so their markers end.
      const events = await loadSubagentEvents(slackParentConversationId);
      const started = events.flatMap((event) =>
        event.type === "subagent_started" ? [event.subagentInvocationId] : [],
      );
      expect(started).toHaveLength(2);
      expect(
        events.flatMap((event) =>
          event.type === "subagent_ended" && event.outcome === "aborted"
            ? [event.subagentInvocationId]
            : [],
        ),
      ).toEqual(expect.arrayContaining(started));

      // A replay of the dropped message is not new work.
      vi.setSystemTime(1_800_000_001_000);
      await message(harness, childId, "call-2");
      await expect(getConversationStoppedAtMs(childId)).resolves.toEqual(
        expect.any(Number),
      );
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("runs a grandchild's new task after a tree stop, and not its task from before the stop", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      const childRun = { ...parentRun("child-turn"), conversationId: childId };
      const deps = { queue: harness.queue, state: harness.state };
      const { childConversationId: grandchildId } = await bindSpawnAgent(
        childRun,
        {
          ...deps,
          conversationStore: harness.conversationStore,
          maxAgentDepth: 1,
        },
      )!({ task: "Run the old check." }, { toolCallId: "child-call-1" });
      await expect(
        createStopAgentTool(slackParentConversationId).execute!(
          { conversation_id: childId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });

      // New work ends the stop of the tree, and the child gives the
      // grandchild a new task.
      vi.setSystemTime(1_800_000_001_000);
      await message(harness, childId, "call-2");
      await bindMessageAgent(childRun, deps)!(
        { text: "Run the new check.", to: grandchildId },
        { toolCallId: "child-call-2" },
      );
      harness.onRun(finishRun);
      await harness.drain(grandchildId);

      expect(harness.runs).toHaveLength(1);
      expect(harness.runs[0]!.instruction.text).toContain("Run the new check.");
      expect(harness.runs[0]!.instruction.text).not.toContain(
        "Run the old check.",
      );
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      name: "different Actors",
      other: {
        actor: { ...slackInvocationInput.actor, userId: "U999" },
        credentialContext: { actor: { type: "user", userId: "U999" } },
      },
    },
    {
      name: "one Actor with different credentials",
      other: {
        actor: slackInvocationInput.actor,
        credentialContext: { actor: { platform: "system", name: "junior" } },
      },
    },
  ] satisfies {
    name: string;
    other: Pick<AgentRun, "actor" | "credentialContext">;
  }[])(
    "runs parent messages from $name as separate Turns",
    async ({ other }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await spawn(harness, "call-1");
        vi.setSystemTime(1_800_000_001_000);
        await bindMessageAgent(
          { ...parentRun(), ...other },
          { queue: harness.queue, state: harness.state },
        )!({ text: "Check it again.", to: childId }, { toolCallId: "call-2" });
        harness.onRun(finishRun);
        await harness.drain(childId);

        // The Turn derives its credentials from its Actor, so only the
        // split into two Turns shows the credentials of each message.
        expect(harness.runs.map((run) => run.actor)).toEqual([
          slackInvocationInput.actor,
          other.actor,
        ]);
        expect(harness.runs[0]!.instruction.text).not.toContain(
          "Check it again.",
        );
        expect(harness.runs[1]!.instruction.text).toContain("Check it again.");
      } finally {
        await harness.close();
      }
    },
  );

  it("leaves a stopped parent's message as a note that the child's next Turn shows", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await startParentTurn();
      // A person stops the parent and its tree, which drops the child's
      // waiting task. The parent's run sees its stop late, and messages the
      // child first.
      await stopConversationAndChildAgents({
        conversationId: slackParentConversationId,
        nowMs: Date.now(),
        queue: harness.queue,
        state: harness.state,
        stoppedAtMs: Date.now(),
      });
      vi.setSystemTime(1_800_000_001_000);
      const tool = createMessageAgentTool(
        bindMessageAgent(parentRun(), {
          queue: harness.queue,
          state: harness.state,
        })!,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          tool.execute!(
            { text: "Check it again.", to: childId },
            { toolCallId: "call-2" },
          ),
        ).resolves.toEqual({ conversation_id: childId, delivery: "noted" });
      }
      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        1_800_000_000_000,
      );
      await expect(mailboxTexts(harness, childId)).resolves.toEqual([]);

      // A person writes to the parent, which ends the stop of the tree. The
      // parent's next message starts the child, and its Turn shows the note.
      vi.setSystemTime(1_800_000_002_000);
      await resumeConversationTree(slackParentConversationId, Date.now());
      await message(harness, childId, "call-3");
      harness.onRun(finishRun);
      await harness.processUntilRun(childId);
      expect(harness.runs).toHaveLength(1);
      await expect(
        loadTurnConversationNotes({
          conversationId: childId,
          turnId: harness.runs[0]!.turnId,
        }),
      ).resolves.toEqual([
        {
          text: "Your parent agent sent this message while it was stopped, so it started no work: Check it again.",
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("refuses a spawn from a stopped parent", async () => {
    const harness = await createHarness();
    try {
      await startParentTurn();
      await stopConversationTree([slackParentConversationId], {
        stoppedAtMs: Date.now(),
        state: harness.state,
      });

      await expect(spawn(harness, "call-1")).rejects.toBeInstanceOf(
        AgentStoppedError,
      );
      const tool = createStartAgentTool(
        bindSpawnAgent(parentRun(), {
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        })!,
        { owner: "none" },
      );
      await expect(
        tool.execute!(tool.prepareArguments({ task: "Check the deploy." }), {
          toolCallId: "call-2",
        }),
      ).rejects.toSatisfy(
        (error) =>
          error instanceof ToolInputError &&
          error.message.endsWith("Do not start more work. End this turn."),
      );
      expect(harness.queue.sentRecords()).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("stops every child of a parent whose run sees its stop late", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      // The spawn raced the stop: it created the child after the stop, so
      // the stop of the tree missed the child.
      const childId = await spawn(harness, "call-1");
      await stopConversationTree([slackParentConversationId], {
        stoppedAtMs: 1_799_999_999_000,
        state: harness.state,
      });
      await stopChildAgentsOf(slackParentConversationId, harness.state);

      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        1_799_999_999_000,
      );
      await harness.drain(childId);
      expect(harness.runs).toEqual([]);
    } finally {
      await harness.close();
    }
  });
  it("lets a parent give work in a Turn that started after its stop", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const threadId = await spawn(harness, "call-1", { kind: "thread" });
      await stopConversationTree([slackParentConversationId, threadId], {
        stoppedAtMs: Date.now(),
        state: harness.state,
      });
      // A person resumes only the Thread. Its reply starts a parent Turn
      // while the parent's stop stays.
      vi.setSystemTime(1_800_000_001_000);
      await resumeConversationTree(threadId, Date.now());
      vi.setSystemTime(1_800_000_002_000);
      await startParentTurn("parent-turn-2");

      // The Thread's task still waits, so the message queues behind it.
      await expect(
        message(harness, threadId, "call-2", "parent-turn-2"),
      ).resolves.toEqual({ conversationId: threadId, delivery: "queued" });
      await expect(mailboxTexts(harness, threadId)).resolves.toEqual([
        "Check the deploy.",
        "Check it again.",
      ]);
      const taskId = await spawn(
        harness,
        "call-3",
        {},
        harness.state,
        "parent-turn-2",
      );
      await expect(mailboxTexts(harness, taskId)).resolves.toEqual([
        "Check the deploy.",
      ]);
      await expect(
        getConversationStoppedAtMs(slackParentConversationId),
      ).resolves.toBe(1_800_000_000_000);
    } finally {
      await harness.close();
    }
  });

  it("counts a parent as stopped when a stop sent before its Turn arrives during it", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await sendPersonMessage(harness, slackParentConversationId, "person-1");
      vi.setSystemTime(1_800_000_002_000);
      await startParentTurn();
      // The person's stop message was sent before this Turn started, but the
      // stop arrives while the Turn runs.
      await stopConversationTree([slackParentConversationId, childId], {
        stoppedAtMs: 1_800_000_001_000,
        state: harness.state,
      });
      await stopConversationWork({
        conversationId: slackParentConversationId,
        state: harness.state,
      });

      vi.setSystemTime(1_800_000_003_000);
      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "noted",
      });
      await expect(getConversationStoppedAtMs(childId)).resolves.toBe(
        1_800_000_001_000,
      );
      await expect(spawn(harness, "call-3")).rejects.toBeInstanceOf(
        AgentStoppedError,
      );
    } finally {
      await harness.close();
    }
  });

  it("counts a parent as stopped while its run has a stop request, after a person resumes it", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await spawn(harness, "call-1");
      await sendPersonMessage(harness, slackParentConversationId, "person-1");
      vi.setSystemTime(1_800_000_001_000);
      await startParentTurn();
      await stopConversationTree([slackParentConversationId], {
        stoppedAtMs: Date.now(),
        state: harness.state,
      });
      await stopConversationWork({
        conversationId: slackParentConversationId,
        state: harness.state,
      });
      // A person resumes the parent before its run sees the stop request.
      vi.setSystemTime(1_800_000_002_000);
      await resumeConversationTree(slackParentConversationId, Date.now());

      await expect(message(harness, childId, "call-2")).resolves.toEqual({
        conversationId: childId,
        delivery: "noted",
      });
      await expect(spawn(harness, "call-3")).rejects.toBeInstanceOf(
        AgentStoppedError,
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps a Thread that a person resumed running when its parent's late stop runs", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const threadId = await spawn(harness, "call-1", { kind: "thread" });
      vi.setSystemTime(1_800_000_001_000);
      await stopConversationTree([slackParentConversationId, threadId], {
        stoppedAtMs: Date.now(),
        state: harness.state,
      });
      // A person resumes only the Thread. Then the parent's run sees its
      // stop late.
      vi.setSystemTime(1_800_000_002_000);
      await resumeConversationTree(threadId, Date.now());
      await sendPersonMessage(harness, threadId, "person-1");
      await stopChildAgentsOf(slackParentConversationId, harness.state);

      await expect(getConversationStoppedAtMs(threadId)).resolves.toBe(
        undefined,
      );
      harness.onRun(finishRun);
      await harness.drain(threadId);
      expect(
        harness.runs.some((run) =>
          run.instruction.text.includes("What did you find?"),
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
