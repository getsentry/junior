import { setConversationVisibility } from "@/chat/conversations/sql/privacy";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@/chat/agent/types";
import { messageChildAgent, spawnChildAgent } from "@/chat/child-agents/create";
import type { SpawnChildAgentInput } from "@/chat/child-agents/types";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { getAutomatedTurnLimitState } from "@/chat/services/automated-turn-limit";
import { createListWatchesTool } from "@/chat/tools/list-watches";
import { createStopWatchingResourcesTool } from "@/chat/tools/stop-watches";
import { createWatchTimerTool } from "@/chat/tools/watch-timer";
import type { User } from "@sentry/junior-plugin-api";
import { getConversationEventStore, getDb, getSqlExecutor } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { context, execute } from "../fixtures/event-automations";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import { loadMessageEvents } from "../fixtures/child-agents";
import { stoppedConversationMessageTexts } from "../fixtures/conversation";
import { deferred } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
import { createModelAgentRunnerForRun } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";

const parentConversationId = "local:test:child-agent-concurrency";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const baseInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  input: "Do the delegated work.",
  parentConversationId,
};

async function listAgents() {
  return await createListAgentsTool({ conversationId: parentConversationId })
    .execute!({}, {});
}

/** The child replies and results that reached a Conversation's mailbox. */
async function mailboxTexts(conversationId: string) {
  return (
    (await getConversationWorkState({ conversationId }))?.messages.map(
      (message) => message.input.text,
    ) ?? []
  );
}

const NO_ANSWER = "Do not answer.";

/**
 * Reply with the input as final text, or end with no text for `NO_ANSWER`.
 * With `reply`, always reply with that text.
 */
function taskModel(request: AgentRun, reply?: string): AgentRequestStreamFn {
  return createModelStream([
    {
      type: "text",
      text:
        reply === undefined && request.instruction.text.includes(NO_ANSWER)
          ? ""
          : (reply ?? `result:${request.instruction.text}`),
    },
  ]);
}

async function createHarness(
  streamForRun: (request: AgentRun) => AgentRequestStreamFn,
) {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  const agentRunner = createModelAgentRunnerForRun(streamForRun);
  const run = vi.spyOn(agentRunner, "run");
  const {
    queue,
    run: route,
    state,
  } = await createConversationWorkHarness(agentRunner);
  // This harness runs only child work. Each child result also wakes the
  // parent, and its results stay in the parent's mailbox.
  const processNext = async () => {
    const message = queue.takeMessage();
    if (message.conversationId === parentConversationId) {
      return;
    }
    await processConversationQueueMessage(message, {
      conversationStore,
      queue,
      run: route,
      state,
    });
  };

  return {
    async close() {
      await fixture.close();
    },
    async drainQueuedWork() {
      while (queue.hasQueuedMessages()) {
        const batch = queue.queuedMessages();
        await Promise.all(batch.map(processNext));
      }
    },
    processQueuedBatch: async () => {
      const batch = queue.queuedMessages();
      await Promise.all(batch.map(processNext));
    },
    /** Send one parent message to an existing child, as messageAgent does. */
    message: async (args: {
      childConversationId: string;
      idempotencyKey: string;
      input: string;
    }) =>
      await messageChildAgent(
        {
          ...baseInput,
          ...args,
          parentToolCallId: args.idempotencyKey,
          parentTurnId: args.idempotencyKey,
        },
        { conversationStore, queue, state },
      ),
    queue,
    state,
    requests: (): AgentRun[] => run.mock.calls.map(([request]) => request),
    /** Spawn one child agent, as startAgent does. */
    spawn: async (
      overrides: Partial<SpawnChildAgentInput> & { idempotencyKey: string },
    ) =>
      await spawnChildAgent(
        {
          ...baseInput,
          ...overrides,
          parentToolCallId: overrides.idempotencyKey,
          parentTurnId: overrides.idempotencyKey,
        },
        { conversationStore, queue, state },
      ),
  };
}

describe("child agent identity and concurrency", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("gives each unnamed child a fresh Conversation without inherited history", async () => {
    const harness = await createHarness(taskModel);
    try {
      const first = await harness.spawn({
        idempotencyKey: "fresh-1",
        input: "first unnamed task",
      });
      await harness.drainQueuedWork();
      const second = await harness.spawn({
        idempotencyKey: "fresh-2",
        input: "second unnamed task",
      });
      await harness.drainQueuedWork();

      expect(second.childConversationId).not.toBe(first.childConversationId);
      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.history?.messages)).toEqual([
        [],
        [],
      ]);
      // Each child's result reached the parent.
      await expect(mailboxTexts(parentConversationId)).resolves.toEqual([
        expect.stringMatching(/status="done"[\s\S]*first unnamed task/),
        expect.stringMatching(/status="done"[\s\S]*second unnamed task/),
      ]);
    } finally {
      await harness.close();
    }
  });

  it("continues a named child with a message and supplies its completed history", async () => {
    const harness = await createHarness(taskModel);
    try {
      const first = await harness.spawn({
        agentName: "researcher",
        idempotencyKey: "named-1",
        input: "first named task",
        reasoningLevel: "high",
        title: "Research",
      });
      await harness.drainQueuedWork();
      await expect(
        harness.message({
          childConversationId: first.childConversationId,
          idempotencyKey: "named-2",
          input: "second named task",
        }),
      ).resolves.toEqual({ delivery: "started" });
      await expect(listAgents()).resolves.toMatchObject({
        agents: [
          {
            conversation_id: first.childConversationId,
            kind: "task",
            name: "researcher",
            relation: "child",
            status: "running",
            task: "Research",
          },
        ],
      });
      await harness.drainQueuedWork();

      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.conversationId)).toEqual([
        first.childConversationId,
        first.childConversationId,
      ]);
      expect(requests[0]?.history?.messages).toEqual([]);
      expect(requests[0]?.reasoning).toBe("high");
      expect(requests[0]?.disabledFeatures).toEqual(["interactive-auth"]);
      // A message keeps the reasoning level of the child.
      expect(requests[1]?.reasoning).toBe("high");
      expect(requests[1]?.disabledFeatures).toEqual(["interactive-auth"]);
      expect(requests[1]?.history?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );
      expect(JSON.stringify(requests[1]?.history?.messages)).toContain(
        "result:",
      );
      expect(JSON.stringify(requests[1]?.history?.messages)).toContain(
        "first named task",
      );
      // The child sees the parent's message as a parent agent task.
      expect(requests[1]?.instruction.text).toMatch(
        /<parent-agent-task>\n[\s\S]*second named task\n<\/parent-agent-task>/,
      );
      await expect(mailboxTexts(parentConversationId)).resolves.toEqual([
        expect.stringContaining("first named task"),
        expect.stringMatching(/name="researcher"[\s\S]*second named task/),
      ]);
    } finally {
      await harness.close();
    }
  });

  it("runs different named children in parallel without sharing history", async () => {
    const started = new Set<string>();
    const release = deferred<void>();
    const bothStarted = deferred<void>();
    const taskOf = (request: AgentRun) =>
      ["parallel first", "parallel second"].find((task) =>
        request.instruction.text.includes(task),
      )!;
    const harness = await createHarness((request) => {
      const task = taskOf(request);
      started.add(task);
      if (started.size === 2) {
        bothStarted.resolve(undefined);
      }
      return createModelStream([
        { type: "text", text: `result:${task}`, waitFor: release.promise },
      ]);
    });
    try {
      const [first, second] = await Promise.all([
        harness.spawn({
          agentName: "researcher",
          idempotencyKey: "parallel-1",
          input: "parallel first",
        }),
        harness.spawn({
          agentName: "reviewer",
          idempotencyKey: "parallel-2",
          input: "parallel second",
        }),
      ]);
      const processing = harness.processQueuedBatch();
      await bothStarted.promise;

      expect(started).toEqual(new Set(["parallel first", "parallel second"]));
      expect(
        Object.fromEntries(
          harness
            .requests()
            .map((request) => [taskOf(request), request.history?.messages]),
        ),
      ).toEqual({
        "parallel first": [],
        "parallel second": [],
      });
      expect(first.childConversationId).not.toBe(second.childConversationId);
      release.resolve(undefined);
      await processing;
      const results = await mailboxTexts(parentConversationId);
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /name="researcher"[\s\S]*result:parallel first/,
          ),
          expect.stringMatching(/name="reviewer"[\s\S]*result:parallel second/),
        ]),
      );
    } finally {
      release.resolve(undefined);
      await harness.close();
    }
  });

  it("keeps a successful parallel child independent from a failing sibling", async () => {
    const harness = await createHarness((request) =>
      createModelStream([
        request.instruction.text.includes("failing sibling")
          ? { type: "error", errorMessage: "sibling failed" }
          : { type: "text", text: "successful sibling result" },
      ]),
    );
    try {
      const [successful, failing] = await Promise.all([
        harness.spawn({
          idempotencyKey: "sibling-success",
          input: "successful sibling",
          title: "successful sibling",
        }),
        harness.spawn({
          idempotencyKey: "sibling-failure",
          input: "failing sibling",
          title: "failing sibling",
        }),
      ]);
      await harness.drainQueuedWork();

      expect(
        harness
          .requests()
          .map((request) => request.conversationId)
          .sort(),
      ).toEqual(
        [successful.childConversationId, failing.childConversationId].sort(),
      );
      const results = await mailboxTexts(parentConversationId);
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /status="done"[\s\S]*successful sibling result/,
          ),
          expect.stringMatching(/status="failed"[\s\S]*sibling failed/),
        ]),
      );
      const successfulChild = {
        conversation_id: successful.childConversationId,
        kind: "task",
        status: "idle",
        task: "successful sibling",
      };
      const failingChild = {
        conversation_id: failing.childConversationId,
        kind: "task",
        status: "idle",
        task: "failing sibling",
      };
      const listed = await listAgents();
      expect(listed.agents).toHaveLength(2);
      expect(listed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relation: "child", ...successfulChild }),
          expect.objectContaining({ relation: "child", ...failingChild }),
        ]),
      );
      // Child results arrive as new tasks, so a child offers no Watch.
      for (const agent of listed.agents) {
        expect(agent).not.toHaveProperty("subscribable");
      }
      // A child agent sees itself, its parent, and its sibling. Only the
      // sibling's updates do not reach it, so only the sibling offers a Watch.
      const team = await createListAgentsTool({
        conversationId: successful.childConversationId,
        parentConversationId,
      }).execute!({}, {});
      expect(team).toMatchObject({
        agents: [
          { relation: "self", ...successfulChild },
          {
            conversation_id: parentConversationId,
            relation: "parent",
            // Both child results wait in the parent mailbox.
            status: "pending",
          },
          {
            relation: "sibling",
            ...failingChild,
            subscribable: {
              identifier: failing.childConversationId,
              namespace: "junior",
              suggested_events: ["agent.update"],
              type: "agent",
            },
          },
        ],
      });
      expect(team.agents[0]).not.toHaveProperty("subscribable");
      expect(team.agents[1]).not.toHaveProperty("subscribable");
    } finally {
      await harness.close();
    }
  });

  it("wakes a child with its own timer by the same rules as a root Conversation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const harness = await createHarness(taskModel);
    try {
      const child = await harness.spawn({
        agentName: "watcher",
        idempotencyKey: "watch-1",
        input: "Watch the deploy.",
        title: "Watch the deploy.",
      });
      await harness.drainQueuedWork();

      const childContext = {
        ...context(),
        conversationId: child.childConversationId,
      };
      const childTools = {
        listWatches: createListWatchesTool(childContext),
        watchTimer: createWatchTimerTool(childContext),
      };
      const timer = (await execute(
        childTools["watchTimer"]!,
        { after_ms: 60_000, intent: "Check the deploy again." },
        "child-timer",
      )) as { id: string };
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      // The event batch waits for its burst window, as on a root.
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();

      // The timer runs on the child's Conversation loop as the event Actor,
      // with an event Source and the grants of the person who set it.
      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      const timerRun = requests[1]!;
      expect(timerRun).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: child.childConversationId,
        credentialContext: {
          actor: EVENT_SYSTEM_ACTOR,
          subject: expect.objectContaining({
            binding: expect.objectContaining({
              conversationId: child.childConversationId,
              watchId: timer.id,
            }),
          }),
        },
        parentConversationId,
        source: {
          kind: "event",
          eventType: "timer.fired",
          namespace: "junior",
        },
      });
      // The child transcript shows the timer input as an Event, as on a root.
      await expect(
        loadMessageEvents(child.childConversationId),
      ).resolves.toContainEqual(
        expect.objectContaining({
          meta: expect.objectContaining({
            eventNamespace: "junior",
            eventType: "timer.fired",
          }),
          role: "user",
        }),
      );
      // Its final text reaches the parent once.
      const parentWork = await getConversationWorkState({
        conversationId: parentConversationId,
        state: harness.state,
      });
      expect(
        parentWork?.messages
          .map((message) => message.input.text)
          .filter((text) => text.includes("Check the deploy again.")),
      ).toHaveLength(1);
      // The timer Turn counts toward the automated-turn limit, as on a root.
      await expect(
        getAutomatedTurnLimitState({
          conversationId: child.childConversationId,
        }),
      ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });
      // listAgents still shows the task from the parent.
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "idle", task: "Watch the deploy." }],
      });

      // A stop of the idle child keeps its watches and holds their events:
      // a timer event that already reached it and a later one are both
      // saved to its transcript with no Turn.
      await execute(
        childTools["watchTimer"]!,
        { after_ms: 60_000, intent: "Check once more." },
        "child-timer-2",
      );
      await execute(
        childTools["watchTimer"]!,
        { after_ms: 600_000, intent: "Check much later." },
        "child-timer-3",
      );
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      const stopAgent = createStopAgentTool(parentConversationId);
      await expect(
        stopAgent.execute!({ conversation_id: child.childConversationId }, {}),
      ).resolves.toMatchObject({ stopped: true });
      await expect(execute(childTools["listWatches"]!, {})).resolves.toEqual({
        subscriptions: [
          expect.objectContaining({ intent: "Check much later." }),
        ],
      });
      clock.mockReturnValue(clock() + 600_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      await harness.drainQueuedWork();
      expect(harness.requests()).toHaveLength(2);
      await expect(
        stoppedConversationMessageTexts(child.childConversationId),
      ).resolves.toEqual([
        expect.stringContaining("Check once more."),
        expect.stringContaining("Check much later."),
      ]);
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "stopped" }],
      });

      // A message from the parent starts the child again and resets its
      // automated-turn count. The mailbox then delivers the held timers as
      // one Event Turn, which counts, and its new watches work.
      await harness.message({
        childConversationId: child.childConversationId,
        idempotencyKey: "message-1",
        input: "Watch the deploy again.",
      });
      await harness.drainQueuedWork();
      await expect(
        getAutomatedTurnLimitState({
          conversationId: child.childConversationId,
        }),
      ).resolves.toMatchObject({ consecutiveAutomatedTurns: 1 });
      expect(JSON.stringify(harness.requests().at(-1)?.instruction)).toContain(
        "Check much later.",
      );
      await expect(listAgents()).resolves.toMatchObject({
        agents: [{ status: "idle" }],
      });
      await execute(
        childTools["watchTimer"]!,
        { after_ms: 60_000, intent: "Check after the restart." },
        "child-timer-4",
      );
      clock.mockReturnValue(clock() + 120_000);
      await runTimerWatchHeartbeat({ nowMs: clock(), queue: harness.queue });
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();
      expect(harness.requests().map((request) => request.source.kind)).toEqual([
        "parent_message",
        "event",
        "parent_message",
        "event",
        "event",
      ]);
    } finally {
      clock.mockRestore();
      await harness.close();
    }
  });

  // An idle child, such as after a Watch Event Turn that spawned a helper,
  // gets the helper's result on its Conversation loop. That Turn answers the
  // parent itself. A child Turn that ends with no text tells the parent that
  // it failed. It runs as the web user who started it, but cannot
  // wait for that person to sign in.
  it.each([
    {
      name: "a Task reply",
      kind: "task",
      finding: "Helper fact: 42.",
      expected: ["Helper fact"],
    },
    {
      name: "a Task with no answer",
      kind: "task",
      finding: NO_ANSWER,
      expected: ['status="failed"'],
    },
    {
      name: "a Thread with no answer",
      kind: "thread",
      finding: NO_ANSWER,
      expected: ['status="failed"'],
    },
  ] as const)(
    "runs a grandchild result on the child's Conversation loop for $name",
    async ({ expected, finding, kind }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      let helperId: string | undefined;
      // The helper answers with the finding. The child runs the task model.
      const harness = await createHarness((request) =>
        taskModel(
          request,
          request.conversationId === helperId ? finding : undefined,
        ),
      );
      try {
        const actor = {
          platform: "web" as const,
          userId: "alice@example.com",
          email: "alice@example.com",
          fullName: "Alice",
        };
        const child = await harness.spawn({
          actor,
          idempotencyKey: "loop-child",
          input: "Watch the deploy.",
          kind,
        });
        await harness.drainQueuedWork();
        const parentBefore = await mailboxTexts(parentConversationId);
        ({ childConversationId: helperId } = await harness.spawn({
          actor,
          idempotencyKey: "loop-helper",
          parentConversationId: child.childConversationId,
        }));
        // The helper's Turn sends its result to the child.
        await harness.processQueuedBatch();
        // The child Turn runs after the Event burst window, as on a root.
        clock.mockReturnValue(clock() + 60_000);
        await harness.drainQueuedWork();

        const requests = harness
          .requests()
          .filter(
            (request) => request.conversationId === child.childConversationId,
          );
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({
          actor,
          conversationId: child.childConversationId,
          disabledFeatures: ["interactive-auth"],
          parentConversationId,
          source: { kind: "event" },
        });
        expect(requests[1]!.authorization).toBeUndefined();
        // The child's answer reaches the parent once.
        await expect(mailboxTexts(parentConversationId)).resolves.toEqual([
          ...parentBefore,
          ...expected.map((text) => expect.stringContaining(text)),
        ]);
      } finally {
        clock.mockRestore();
        await harness.close();
      }
    },
  );

  it("gives a child the Inbox item tag for an answer to its item", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const harness = await createHarness(taskModel);
    try {
      const child = await harness.spawn({
        agentName: "asker",
        idempotencyKey: "ask-1",
        input: "Ask who owns the login bug.",
      });
      await harness.drainQueuedWork();

      // A private item goes only to people in its Conversation, and a child
      // has none, so make the child's root public.
      await setConversationVisibility(
        getSqlExecutor(),
        parentConversationId,
        "public",
      );
      const alice = (await resolveViewerUserFromSql(
        getDb(),
        "alice@example.com",
      )) as User;
      // The child opened the item, so it is the only linked Conversation.
      const added = (await (
        createAddInboxItemTool(
          {
            conversationId: child.childConversationId,
            resolveActorIdentity: async () => undefined,
            source: { kind: "scheduled_automation" },
          },
          createSlackInboxItemToolServices(() => harness.queue),
        ) as any
      ).execute(
        {
          kind: "action",
          title: "Pick an owner",
          body: "The bug has no owner.",
          assignees: ["alice@example.com"],
          request: {
            question: "Who should own the login bug?",
            fields: [{ id: "owner", kind: "text", label: "Owner" }],
          },
        },
        {},
      )) as { item: { id: string } };
      const id = added.item.id;
      await actOnInboxItem({
        action: "submit",
        answer: { requestId: id, values: { owner: ["Bob"] } },
        delivery: { queue: harness.queue, show: async () => {} },
        id,
        user: alice,
      });
      // The Event batch waits for its burst window, as on a root.
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();

      const requests = harness.requests();
      expect(requests).toHaveLength(2);
      expect(requests[1]!.instruction.text).toBe(
        [
          `<inbox-item-answer id="${id}">`,
          "Question: Who should own the login bug?",
          "Owner (owner): Bob",
          "</inbox-item-answer>",
        ].join("\n"),
      );
    } finally {
      await harness.close();
    }
  });

  it("lets a parent list and stop the watches of its child agents", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    // Each model request of a child, and an action to run during the next one.
    const modelInputs: Array<{ conversationId: string; text: string }> = [];
    let duringNextRequest: (() => Promise<unknown>) | undefined;
    const harness = await createHarness((request) => {
      const stream = taskModel(request);
      return async (model, context, options) => {
        modelInputs.push({
          conversationId: request.conversationId,
          text: JSON.stringify(context.messages),
        });
        const action = duringNextRequest;
        duringNextRequest = undefined;
        await action?.();
        return await stream(model, context, options);
      };
    });
    const notesOf = async (conversationId: string) =>
      (
        await getConversationEventStore().query(conversationId, {
          limit: 100,
          types: ["structured_event"],
        })
      ).events.flatMap(({ data }) =>
        data.type === "structured_event" && data.name === "conversation_note"
          ? [data.content["text"]]
          : [],
      );
    const stoppedNote = (id: string) =>
      `A parent agent stopped your watch ${id}. It will not wake you again. Label: Timer`;
    const count = (text: string, part: string) => text.split(part).length - 1;
    try {
      const [watcher, sibling] = await Promise.all([
        harness.spawn({
          agentName: "watcher",
          idempotencyKey: "owned-1",
          input: "Watch the deploy.",
        }),
        harness.spawn({
          agentName: "sibling",
          idempotencyKey: "owned-2",
          input: "Watch the queue.",
        }),
      ]);
      // A child agent with open work can start its own child agent.
      const helper = await harness.spawn({
        agentName: "helper",
        idempotencyKey: "owned-3",
        input: "Watch the logs.",
        parentConversationId: watcher.childConversationId,
      });
      await harness.processQueuedBatch();
      // The watcher reads the helper's result after the Event burst window.
      clock.mockReturnValue(clock() + 120_000);
      await harness.drainQueuedWork();

      const toolsFor = (conversationId: string) => {
        const toolContext = { ...context(), conversationId };
        return {
          listWatches: createListWatchesTool(toolContext),
          stopWatchingResources: createStopWatchingResourcesTool(toolContext),
          watchTimer: createWatchTimerTool(toolContext),
        };
      };
      const parentTools = toolsFor(parentConversationId);
      const watcherTools = toolsFor(watcher.childConversationId);
      const watchTimer = async (
        tools: ReturnType<typeof toolsFor>,
        intent: string,
      ) => {
        clock.mockReturnValue(clock() + 1_000);
        const timer = (await execute(
          tools["watchTimer"]!,
          { after_ms: 600_000, intent },
          intent,
        )) as { id: string };
        return timer.id;
      };
      const owners = async (tools: ReturnType<typeof toolsFor>) =>
        (
          (await execute(tools["listWatches"]!, {})) as {
            subscriptions: { child_agent?: unknown; id: string }[];
          }
        ).subscriptions.map(({ child_agent, id }) => ({ child_agent, id }));
      const parentWatch = await watchTimer(parentTools, "Check the parent.");
      const watcherWatch = await watchTimer(watcherTools, "Check the deploy.");
      const siblingWatch = await watchTimer(
        toolsFor(sibling.childConversationId),
        "Check the queue.",
      );
      const helperWatch = await watchTimer(
        toolsFor(helper.childConversationId),
        "Check the logs.",
      );
      const watcherAgent = {
        conversation_id: watcher.childConversationId,
        name: "watcher",
      };
      const siblingAgent = {
        conversation_id: sibling.childConversationId,
        name: "sibling",
      };
      const helperAgent = {
        conversation_id: helper.childConversationId,
        name: "helper",
      };

      // The parent sees its own watch and the watch of each child agent
      // below it, with the child agent that owns it.
      await expect(owners(parentTools)).resolves.toEqual([
        { child_agent: undefined, id: parentWatch },
        { child_agent: watcherAgent, id: watcherWatch },
        { child_agent: siblingAgent, id: siblingWatch },
        { child_agent: helperAgent, id: helperWatch },
      ]);
      // A child agent sees its own watches and those of its child agents,
      // never those of its parent or its sibling.
      await expect(owners(watcherTools)).resolves.toEqual([
        { child_agent: undefined, id: watcherWatch },
        { child_agent: helperAgent, id: helperWatch },
      ]);
      for (const id of [parentWatch, siblingWatch]) {
        await expect(
          execute(watcherTools["stopWatchingResources"]!, { id }),
        ).rejects.toThrow(
          "Watch was not found in the current conversation or its child agents.",
        );
      }

      const requestsBeforeStops = modelInputs.length;
      // The parent stops a watch of its child agent by id.
      await expect(
        execute(parentTools["stopWatchingResources"]!, { id: watcherWatch }),
      ).resolves.toEqual({
        stopped_ids: [watcherWatch],
        watching_status: "stopped",
      });
      await expect(owners(watcherTools)).resolves.toEqual([
        { child_agent: helperAgent, id: helperWatch },
      ]);

      // A stop of every watch includes the watches of the child agents below,
      // and nothing above or beside them.
      await expect(
        execute(watcherTools["stopWatchingResources"]!, {}),
      ).resolves.toEqual({
        stopped_ids: [helperWatch],
        watching_status: "stopped",
      });
      await expect(owners(parentTools)).resolves.toEqual([
        { child_agent: undefined, id: parentWatch },
        { child_agent: siblingAgent, id: siblingWatch },
      ]);
      await expect(
        execute(parentTools["stopWatchingResources"]!, {}),
      ).resolves.toEqual({
        stopped_ids: [parentWatch, siblingWatch],
        watching_status: "stopped",
      });
      await expect(owners(parentTools)).resolves.toEqual([]);

      // Each stop of a child agent's watch adds a Conversation note to that
      // child. A stop of a Conversation's own watch adds none. No note starts
      // a Turn.
      expect(harness.queue.hasQueuedMessages()).toBe(false);
      expect(modelInputs).toHaveLength(requestsBeforeStops);
      await expect(notesOf(parentConversationId)).resolves.toEqual([]);
      await expect(notesOf(watcher.childConversationId)).resolves.toEqual([
        stoppedNote(watcherWatch),
      ]);
      await expect(notesOf(sibling.childConversationId)).resolves.toEqual([
        stoppedNote(siblingWatch),
      ]);
      await expect(notesOf(helper.childConversationId)).resolves.toEqual([
        stoppedNote(helperWatch),
      ]);

      // The next Turn of the child shows the note. A note added while that
      // Turn runs waits for the Turn after it. Each note is shown once.
      const lateWatch = await watchTimer(watcherTools, "Check again.");
      duringNextRequest = () =>
        execute(parentTools["stopWatchingResources"]!, { id: lateWatch });
      await harness.message({
        childConversationId: watcher.childConversationId,
        idempotencyKey: "owned-message-1",
        input: "Report status.",
      });
      await harness.drainQueuedWork();
      await harness.message({
        childConversationId: watcher.childConversationId,
        idempotencyKey: "owned-message-2",
        input: "Report status again.",
      });
      await harness.drainQueuedWork();
      const nextTurns = modelInputs.slice(requestsBeforeStops);
      expect(
        nextTurns.map(({ conversationId, text }) => ({
          conversationId,
          late: count(text, stoppedNote(lateWatch)),
          stopped: count(text, stoppedNote(watcherWatch)),
        })),
      ).toEqual([
        { conversationId: watcher.childConversationId, late: 0, stopped: 1 },
        { conversationId: watcher.childConversationId, late: 1, stopped: 1 },
      ]);
      expect(nextTurns[1]!.text.indexOf(stoppedNote(lateWatch))).toBeLessThan(
        nextTurns[1]!.text.indexOf("Report status again."),
      );
    } finally {
      clock.mockRestore();
      await harness.close();
    }
  });
});
