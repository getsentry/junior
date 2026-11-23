import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import { listUnreportedSiblingAgents } from "@/chat/agent-invocations/list";
import {
  createDeliverToParent,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import type { ChildAgentSender } from "@/chat/agent-invocations/types";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { botConfig } from "@/chat/config";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { ingestEvent } from "@/chat/events/ingest";
import { createWatch, listWatches } from "@/chat/events/store";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { stopAtAutomatedTurnLimit } from "@/chat/slack/automated-turn-limit-notice";
import { createEventInboundMessage } from "@/chat/events/notification";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  loadTurnEvents,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import {
  stoppedConversationMessageTexts,
  storeConversationStop,
  webTestActor,
} from "../fixtures/conversation";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import {
  createHarness,
  finishRun,
  sendPersonMessage,
  startThread,
  type Harness,
} from "../fixtures/thread-input";

/** Start a child whose spawn Turn has ended, so it has no open work. */
async function startIdleChild(harness: Harness, kind: "task" | "thread") {
  const childId = await startThread(harness, `${kind}-spawn`, { kind });
  harness.onRun(finishRun);
  await harness.drain(childId);
  harness.onRun(undefined);
  return childId;
}

/** Spawn one helper agent of a child, as the child's `spawnAgent` does. */
async function createHelper(
  harness: Harness,
  childId: string,
  overrides: Partial<Parameters<typeof spawnChildAgent>[0]> = {},
): Promise<ChildAgentSender> {
  const { childConversationId } = await spawnChildAgent(
    {
      ...slackInvocationInput,
      idempotencyKey: "helper",
      parentConversationId: childId,
      parentToolCallId: "helper",
      parentTurnId: "child-turn",
      ...overrides,
    },
    {
      conversationStore: harness.conversationStore,
      queue: harness.queue,
      state: harness.state,
    },
  );
  return { childConversationId, parentConversationId: childId };
}

/** Send a helper's `reply` to its parent, the child. */
async function sendHelperReply(harness: Harness, sender: ChildAgentSender) {
  await enqueueChildResultToParent({
    actor: slackInvocationInput.actor,
    messageKey: "helper-reply",
    nowMs: Date.now(),
    queue: harness.queue,
    result: {
      kind: "reply",
      reply: { text: "Helper fact.", toolCallId: "helper-reply" },
    },
    sender,
    turnId: "turn_helper",
    state: harness.state,
  });
  // Event input waits for its burst window, as on a root.
  vi.setSystemTime(Date.now() + 60_000);
}

async function parentMessageTexts() {
  return (
    (
      await getConversationWorkState({
        conversationId: slackParentConversationId,
      })
    )?.messages.map((message) => message.input.text) ?? []
  );
}

describe("child Turns on the Conversation loop", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  // A grandchild's result runs on the child's Conversation loop as the Actor
  // of the grandchild's Turn only. The grants of the timer Turn that spawned
  // the grandchild do not come with it.
  it("runs a grandchild result as its Turn's Actor without the spawn's grants", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      const helper = await createHelper(harness, childId, {
        actor: EVENT_SYSTEM_ACTOR,
        credentialContext: {
          actor: EVENT_SYSTEM_ACTOR,
          subject: bindTimerWatchCredentialSubject({
            conversationId: childId,
            userId: webTestActor.userId,
            watchId: "watch-1",
          })!,
        },
      });
      await createDeliverToParent({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: helper.childConversationId,
        result: { kind: "blocked", text: "Needs a token." },
        turnId: "turn_helper",
      });
      vi.setSystemTime(Date.now() + 60_000);
      await harness.processUntilRun(childId);

      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: childId,
      });
      expect(run.credentialContext).toEqual({ actor: EVENT_SYSTEM_ACTOR });
    } finally {
      await harness.close();
    }
  });

  // Only a gated Turn answers the parent, so only it keeps the child
  // running. A person's Turn in a Thread does not.
  it.each([
    { input: "helper reply", running: true },
    { input: "person message", running: false },
  ] as const)(
    "shows a Thread as running only while a Turn that answers runs ($input)",
    async ({ input, running }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, "thread");
        const seen: unknown[] = [];
        harness.onRun(async () => {
          seen.push(
            await createListAgentsTool({
              conversationId: slackParentConversationId,
            }).execute!({}, {}),
            (
              await listUnreportedSiblingAgents(
                slackParentConversationId,
                "agent:sibling",
                [],
              )
            ).map((agent) => agent.childConversationId),
          );
          throw new Error("stop after reading the run");
        });
        if (input === "helper reply") {
          await sendHelperReply(harness, await createHelper(harness, childId));
        } else {
          await sendPersonMessage(harness, childId, "person-message");
        }
        await harness.processUntilRun(childId);

        expect(seen).toEqual([
          {
            agents: [
              expect.objectContaining({
                status: running ? "running" : "idle",
              }),
            ],
          },
          running ? [childId] : [],
        ]);
      } finally {
        await harness.close();
      }
    },
  );

  it("shows a child as running while its Watch Event waits in the mailbox", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      // A sibling also has input in its mailbox, but a person's message does
      // not answer the parent.
      const threadId = await startIdleChild(
        { ...harness, agentName: `${harness.agentName}-sibling` },
        "thread",
      );
      await sendPersonMessage(harness, threadId, "person-message");
      // The Event is in its debounce window, so no worker has taken it.
      await appendAndEnqueueInboundMessage({
        message: createEventInboundMessage({
          event: {
            eventKey: "deploy-1",
            eventType: "deployment.failed",
            identifier: "getsentry/junior",
            namespace: "github",
            occurredAtMs: Date.now(),
            trustedSummary: "A deployment failed.",
          },
          subscription: { conversationId: childId, id: "watch-1" },
          text: "Deploy failed.",
        }),
        queue: harness.queue,
        state: harness.state,
      });

      const { agents } = (await createListAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {})) as {
        agents: Array<{ conversation_id: string; status: string }>;
      };
      expect(
        Object.fromEntries(
          agents.map((agent) => [agent.conversation_id, agent.status]),
        ),
      ).toEqual({ [childId]: "running", [threadId]: "idle" });
      await expect(
        listUnreportedSiblingAgents(
          slackParentConversationId,
          "agent:sibling",
          [],
        ),
      ).resolves.toEqual([
        expect.objectContaining({ childConversationId: childId }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { kind: "task" as const, notices: 1 },
    { kind: "thread" as const, notices: 0 },
  ])(
    "tells only a Task's parent when its Conversation loop Turn fails ($kind)",
    async ({ kind, notices }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, kind);
        const before = await parentMessageTexts();
        await sendHelperReply(harness, await createHelper(harness, childId));
        // The runner throws on each try, so the last try fails the Turn.
        for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
          await harness.drain(childId);
          await runHeartbeatAfterLeasesExpire(harness.queue);
        }

        expect(harness.runs.at(-1)).toMatchObject({ conversationId: childId });
        expect(
          (await parentMessageTexts())
            .slice(before.length)
            .filter((text) => text.includes("stop after reading the run")),
        ).toEqual(
          Array.from({ length: notices }, () =>
            expect.stringMatching(/status="failed"/),
          ),
        );
      } finally {
        await harness.close();
      }
    },
  );

  // Routing, the stop skips, and the status read one rule, so a reply that
  // the stop drops never shows the child as running.
  it("does not wait for a child whose queued grandchild reply a stop drops", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      const helper = await createHelper(harness, childId);
      await sendHelperReply(harness, helper);
      await expect(
        createStopAgentTool(childId).execute!(
          { conversation_id: helper.childConversationId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });

      await expect(
        createListAgentsTool({
          conversationId: slackParentConversationId,
        }).execute!({}, {}),
      ).resolves.toEqual({
        agents: [expect.objectContaining({ status: "idle" })],
      });
      await expect(
        listUnreportedSiblingAgents(
          slackParentConversationId,
          "agent:sibling",
          [],
        ),
      ).resolves.toEqual([]);
      const runCount = harness.runs.length;
      await harness.drain(childId);
      expect(harness.runs).toHaveLength(runCount);
    } finally {
      await harness.close();
    }
  });

  it("drops a grandchild reply sent after the grandchild was stopped", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      const helper = await createHelper(harness, childId);
      await expect(
        createStopAgentTool(childId).execute!(
          { conversation_id: helper.childConversationId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });
      vi.setSystemTime(Date.now() + 1_000);
      const runCount = harness.runs.length;
      await sendHelperReply(harness, helper);
      await harness.drain(childId);

      expect(harness.runs).toHaveLength(runCount);
    } finally {
      await harness.close();
    }
  });

  it("ends a child's Conversation loop Turn at its next step after a stored stop", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      harness.onRun(async (run) => {
        // Only the stored stop is set. No stop request reaches the worker.
        await storeConversationStop(run.conversationId);
        // The agent loop checks for a stop at each step boundary.
        await run.durability?.checkStop?.();
        run.signal?.throwIfAborted();
        throw new Error("The stored stop did not abort the run");
      });
      await sendHelperReply(harness, await createHelper(harness, childId));

      await harness.processUntilRun(childId);
      const run = harness.runs.at(-1)!;
      expect(run).toMatchObject({
        conversationId: childId,
        source: { kind: "event" },
      });
      await expect(loadTurnEvents(childId)).resolves.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "cancelled",
            turnId: run.turnId,
            type: "turn_completed",
          }),
        }),
      );
      // A stop is not a result, and it drops the child's unread result of
      // its task Turn, so the parent hears nothing.
      await expect(parentMessageTexts()).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("stops a child at the automated-turn limit and holds its Watch Events", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "task");
      await createWatch(
        {
          conversationId: childId,
          events: ["pull_request.merge_conflict"],
          expiresAtMs: Date.now() + 60_000,
          identifier: "getsentry/junior#3796",
          intent: "Fix merge conflicts.",
          label: "GitHub PR getsentry/junior#3796",
          namespace: "github",
          resourceType: "pull_request",
        },
        { state: harness.state },
      );
      const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
      // The Turn that reached the limit stops the child's tree. A child has
      // no Location, so no notice is posted.
      await stopAtAutomatedTurnLimit({
        conversationId: childId,
        maxTurns,
        update: { consecutiveAutomatedTurns: maxTurns, reached: true },
      });
      await expect(getConversationStoppedAtMs(childId)).resolves.toEqual(
        Date.now(),
      );

      for (const headSha of ["abc123", "def456"]) {
        await expect(
          ingestEvent(
            {
              data: { pullRequest: 3796, repo: "getsentry/junior" },
              eventKey: `github:merge-conflict:getsentry/junior#3796:${headSha}`,
              eventType: "pull_request.merge_conflict",
              identifier: "getsentry/junior#3796",
              namespace: "github",
              occurredAtMs: Date.now(),
              trustedSummary: "getsentry/junior#3796 has merge conflicts.",
            },
            { queue: harness.queue, state: harness.state },
          ),
        ).resolves.toEqual({ enqueued: 0 });
      }

      // The stopped child keeps its Watch and holds its Events as skipped
      // Messages.
      await expect(
        listWatches({ conversationId: childId, state: harness.state }),
      ).resolves.toHaveLength(1);
      await expect(stoppedConversationMessageTexts(childId)).resolves.toEqual([
        expect.stringContaining("getsentry/junior#3796 has merge conflicts."),
        expect.stringContaining("getsentry/junior#3796 has merge conflicts."),
      ]);
    } finally {
      await harness.close();
    }
  });
});
