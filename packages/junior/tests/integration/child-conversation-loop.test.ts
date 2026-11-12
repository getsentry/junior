import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import { listUnreportedSiblingAgents } from "@/chat/agent-invocations/list";
import {
  createDeliverToParent,
  enqueueAgentInvocationResult,
  enqueueChildResultToParent,
} from "@/chat/agent-invocations/result";
import {
  completeAgentInvocation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import type {
  AgentInvocation,
  TerminalAgentInvocation,
} from "@/chat/agent-invocations/types";
import { markConversationsStopped } from "@/chat/conversations/session-stop";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { createEventInboundMessage } from "@/chat/events/notification";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createSearchAgentsTool } from "@/chat/tools/runtime/search-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  loadTurnEvents,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { webTestActor } from "../fixtures/conversation";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import {
  createHarness,
  finishInvocation,
  sendPersonMessage,
  startThread,
  type Harness,
} from "../fixtures/thread-input";

/** Start a child whose spawn Turn has ended, so it has no open row. */
async function startIdleChild(harness: Harness, kind: "task" | "thread") {
  const childId = await startThread(harness, `${kind}-spawn`, { kind });
  await harness.process(childId);
  await finishInvocation(harness, childId);
  return childId;
}

/** Create one open helper agent invocation of a child. */
async function createHelper(
  childId: string,
  overrides: Partial<Parameters<typeof createAgentInvocation>[0]> = {},
) {
  return await createAgentInvocation({
    ...slackInvocationInput,
    idempotencyKey: "helper",
    parentConversationId: childId,
    ...overrides,
  });
}

/** Send a helper's `reply` to its parent, the child. */
async function sendHelperReply(harness: Harness, sender: AgentInvocation) {
  await enqueueChildResultToParent({
    actor: sender.actor,
    messageKey: "helper-reply",
    nowMs: Date.now(),
    queue: harness.queue,
    result: {
      kind: "reply",
      reply: { text: "Helper fact.", toolCallId: "helper-reply" },
    },
    sender,
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

  // A grandchild result still runs on an agent invocation, so a rollback
  // leaves no unread result that `main` would wait for. It keeps the grants
  // of the timer Turn that spawned the grandchild. A reply from a later
  // Watch Event Turn on the grandchild's Conversation loop runs as the Actor
  // only, as on `main`.
  it.each([
    { input: "result", grants: true },
    { input: "reply", grants: false },
  ] as const)(
    "runs a grandchild $input as the spawn's Actor (grants: $grants)",
    async ({ input, grants }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, "task");
        const credentialContext = {
          actor: EVENT_SYSTEM_ACTOR,
          subject: bindTimerWatchCredentialSubject({
            conversationId: childId,
            userId: webTestActor.userId,
            watchId: "watch-1",
          })!,
        };
        const helper = await createHelper(childId, {
          actor: EVENT_SYSTEM_ACTOR,
          credentialContext,
        });
        if (input === "result") {
          const ended = (await completeAgentInvocation({
            errorMessage: "Needs a token.",
            invocationId: helper.invocationId,
            status: "blocked",
          })) as TerminalAgentInvocation;
          await enqueueAgentInvocationResult(ended, {
            queue: harness.queue,
            state: harness.state,
          });
        } else {
          await completeAgentInvocation({
            invocationId: helper.invocationId,
            result: "",
            status: "completed",
          });
          await createDeliverToParent({
            queue: harness.queue,
            state: harness.state,
          })({
            actor: EVENT_SYSTEM_ACTOR,
            conversationId: helper.childConversationId,
            result: {
              kind: "reply",
              reply: { text: "Deploy failed.", toolCallId: "call-reply" },
            },
            turnId: "turn_watch-event",
          });
          vi.setSystemTime(Date.now() + 60_000);
        }
        await harness.processUntilRun(childId);

        const run = harness.runs.at(-1)!;
        expect(run).toMatchObject({
          actor: EVENT_SYSTEM_ACTOR,
          conversationId: childId,
        });
        // Without the spawn's grants, the run has only the Actor's own.
        expect(run.credentialContext).toEqual(
          grants ? credentialContext : { actor: EVENT_SYSTEM_ACTOR },
        );
        expect(run.agentInvocationId !== undefined).toBe(grants);
      } finally {
        await harness.close();
      }
    },
  );

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
        harness.onPersonRun(async (run) => {
          seen.push(
            await createSearchAgentsTool({
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
          expect(run.agentInvocationId).toBeUndefined();
          throw new Error("stop after reading the run");
        });
        if (input === "helper reply") {
          await sendHelperReply(harness, await createHelper(childId));
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

      const { agents } = (await createSearchAgentsTool({
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
        await sendHelperReply(harness, await createHelper(childId));
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
      const helper = await createHelper(childId);
      await sendHelperReply(harness, helper);
      await expect(
        createStopAgentTool(childId).execute!(
          { conversation_id: helper.childConversationId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });

      await expect(
        createSearchAgentsTool({
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
      const helper = await createHelper(childId);
      await expect(
        createStopAgentTool(childId).execute!(
          { conversation_id: helper.childConversationId },
          {},
        ),
      ).resolves.toMatchObject({ stopped: true });
      vi.setSystemTime(Date.now() + 1_000);
      const runCount = harness.runs.length;
      await sendHelperReply(
        harness,
        (await getAgentInvocation(helper.invocationId))!,
      );
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
      harness.onPersonRun(async (run) => {
        // Only the stored stop is set. No stop request reaches the worker.
        await markConversationsStopped([run.conversationId], {
          cancelWatches: false,
        });
        // The agent loop checks for a stop at each step boundary.
        await run.durability?.checkStop?.();
        run.signal?.throwIfAborted();
        throw new Error("The stored stop did not abort the run");
      });
      const before = await parentMessageTexts();
      await sendHelperReply(harness, await createHelper(childId));

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
      // A stop is not a result, so the parent hears nothing.
      await expect(parentMessageTexts()).resolves.toEqual(before);
    } finally {
      await harness.close();
    }
  });
});

// A spawn can stop writing agent invocations only once every deployed reader
// works without one, so a rollback stays safe. These children have none.
