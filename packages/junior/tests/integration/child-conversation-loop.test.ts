import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnChildAgent } from "@/chat/child-agents/create";
import { listUnreportedSiblingAgents } from "@/chat/child-agents/list";
import { resultAuthorId } from "@/chat/child-agents/sender-actors";
import { enqueueStarterUpdate } from "@/chat/child-agents/result";
import type { ChildAgentSender } from "@/chat/child-agents/types";
import { bindTimerWatchCredentialSubject } from "@/chat/credentials/subject";
import { getConversationEventStore, getDb } from "@/chat/db";
import { botConfig } from "@/chat/config";
import type { Actor } from "@/chat/actor";
import { EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { ingestEvent } from "@/chat/events/ingest";
import { createWatch, listWatches } from "@/chat/events/store";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { stopAtAutomatedTurnLimit } from "@/chat/slack/automated-turn-limit-notice";
import { createEventInboundMessage } from "@/chat/events/notification";
import { turnStartedKey } from "@/chat/conversations/turn-lifecycle";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorConversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createArchiveAgentTool } from "@/chat/tools/runtime/archive-agent";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { createWatchEventsTool } from "@/chat/tools/watch-events";
import {
  loadTurnEvents,
  slackSpawnInput,
  slackParentConversationId,
  createPublishChildTurn,
} from "../fixtures/child-agents";
import {
  stoppedConversationMessageTexts,
  storeConversationStop,
  webTestActor,
} from "../fixtures/conversation";
import { runHeartbeatAfterLeasesExpire } from "../fixtures/conversation-work";
import {
  commitRunInput,
  createHarness,
  finishRun,
  sendPersonMessage,
  startThread,
  type Harness,
  yieldRun,
} from "../fixtures/thread-input";

/** Start a child whose spawn Turn has ended, so it has no open work. */
async function startIdleChild(harness: Harness, kind: "task" | "thread") {
  const childId = await startThread(harness, `${kind}-spawn`, { kind });
  harness.onRun(finishRun);
  await harness.drain(childId);
  harness.onRun(undefined);
  return childId;
}

async function createDeployWatch(harness: Harness, conversationId: string) {
  await createWatch(
    {
      conversationId,
      events: ["deployment.failed"],
      expiresAtMs: Date.now() + 600_000,
      identifier: "getsentry/junior",
      intent: "Check the deploy.",
      label: "getsentry/junior deploys",
      namespace: "github",
      resourceType: "deployment_source",
    },
    { state: harness.state },
  );
}

/** Spawn one helper agent of a child, as the child's `startAgent` does. */
async function createHelper(
  harness: Harness,
  childId: string,
  overrides: Partial<Parameters<typeof spawnChildAgent>[0]> = {},
): Promise<ChildAgentSender> {
  const { childConversationId } = await spawnChildAgent(
    {
      ...slackSpawnInput,
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
async function sendHelperReply(
  harness: Harness,
  sender: ChildAgentSender,
  actor: Actor = slackSpawnInput.actor,
) {
  await enqueueStarterUpdate({
    actor,
    messageKey: "helper-reply",
    nowMs: Date.now(),
    queue: harness.queue,
    update: { status: "done", text: "Helper fact." },
    sender,
    turnId: "turn_helper",
    state: harness.state,
  });
  // Event input waits for its burst window, as on a root.
  vi.setSystemTime(Date.now() + 60_000);
}

async function parentMessages() {
  return (
    (
      await getConversationWorkState({
        conversationId: slackParentConversationId,
      })
    )?.messages ?? []
  );
}

async function parentMessageTexts() {
  return (await parentMessages()).map((message) => message.input.text);
}

/** The Conversation notes of the parent. */
async function parentNoteTexts() {
  const page = await getConversationEventStore().query(
    slackParentConversationId,
    { limit: 100, types: ["structured_event"] },
  );
  return page.events.flatMap(({ data }) => {
    if (data.type !== "structured_event") return [];
    const text: unknown = (data.content as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
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
      await createPublishChildTurn({
        queue: harness.queue,
        state: harness.state,
      })({
        actor: EVENT_SYSTEM_ACTOR,
        conversationId: helper.childConversationId,
        update: { status: "blocked", text: "Needs a token." },
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

  // A helper's result is data from the helper, not the person's instruction.
  // The Turn runs as the person, but the result does not count as a
  // message from them, also after the Turn resumes.
  it("runs a helper result as context, not as the person's instruction", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const threadId = await startIdleChild(harness, "thread");
      const lastMessageAt = async () =>
        (
          await getDb()
            .select({ at: juniorConversations.lastMessageAt })
            .from(juniorConversations)
            .where(eq(juniorConversations.conversationId, threadId))
        )[0]?.at;
      const lastMessageBefore = await lastMessageAt();
      const latestInstructionBefore =
        await getConversationEventStore().loadLatestInstruction(threadId);
      // The first run takes the result and yields. The next run resumes
      // that Turn and ends it without a reply.
      harness.onRun(async (run) => {
        const resumed =
          harness.runs.filter((earlier) => earlier.turnId === run.turnId)
            .length > 1;
        if (!run.instruction.text.includes("Helper fact.") || resumed) {
          return await finishRun(run);
        }
        await commitRunInput(run);
        return await yieldRun(run);
      });
      await sendHelperReply(harness, await createHelper(harness, threadId));
      await harness.drain(threadId);

      const resultRuns = harness.runs.filter(
        (run) =>
          run.conversationId === threadId && run.source?.kind === "event",
      );
      expect(resultRuns).toHaveLength(2);
      for (const run of resultRuns) {
        expect(run).toMatchObject({
          actor: slackSpawnInput.actor,
          instruction: {
            provenance: {
              authority: "context",
              actor: slackSpawnInput.actor,
            },
          },
        });
      }
      // Compaction keeps the parent's task as the last instruction.
      await expect(
        getConversationEventStore().loadLatestInstruction(threadId),
      ).resolves.toEqual(latestInstructionBefore);
      // The dashboard and the Inbox see no new message.
      await expect(lastMessageAt()).resolves.toEqual(lastMessageBefore);
      // No person used the Thread, so its parent can archive it.
      const archive = createArchiveAgentTool(slackParentConversationId);
      await expect(
        archive.execute!(
          archive.prepareArguments({
            apply_to_children: true,
            conversation_id: threadId,
          }),
          {},
        ),
      ).resolves.toMatchObject({ conversation_id: threadId });
    } finally {
      await harness.close();
    }
  });

  // Every Turn of a child answers its parent, so each one keeps it running,
  // whoever started it.
  it.each([{ input: "helper reply" }, { input: "person message" }] as const)(
    "shows a Thread as running while its Turn runs ($input)",
    async ({ input }) => {
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
          { agents: [expect.objectContaining({ status: "running" })] },
          [childId],
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
      // A sibling's waiting person message also answers the parent.
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
      ).toEqual({ [childId]: "running", [threadId]: "running" });
      await expect(
        listUnreportedSiblingAgents(
          slackParentConversationId,
          "agent:sibling",
          [],
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ childConversationId: childId }),
          expect.objectContaining({ childConversationId: threadId }),
        ]),
      );
    } finally {
      await harness.close();
    }
  });

  // A Turn that only the Thread's own Watch Events started sends its parent
  // its final text, and the parent decides what to do, whether or not a
  // Watch is left. An Event that
  // arrives during the Turn runs next, and sends its own update. The Turn's
  // own input does not wait, even before the Turn acks it.
  it.each([
    { watchLeft: false, eventWaits: false, acked: true, updates: 1 },
    { watchLeft: false, eventWaits: false, acked: false, updates: 1 },
    { watchLeft: true, eventWaits: false, acked: true, updates: 1 },
    { watchLeft: false, eventWaits: true, acked: true, updates: 2 },
    {
      watchLeft: false,
      eventWaits: false,
      acked: true,
      updates: 1,
      legacyStart: true,
    },
  ])(
    "wakes the parent when a Thread's Watch Turn ends (Watch left: $watchLeft, Event waits: $eventWaits, acked: $acked, legacy start: $legacyStart)",
    async ({ watchLeft, eventWaits, acked, updates, legacyStart }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, "thread");
        if (watchLeft) {
          await createDeployWatch(harness, childId);
        }
        // A Watch on the Thread hears none of these Turns.
        await createWatch(
          {
            conversationId: slackParentConversationId,
            events: ["agent.update"],
            expiresAtMs: Date.now() + 600_000,
            identifier: childId,
            intent: "Follow the deploy check.",
            label: "Deploy check thread",
            namespace: "junior",
            resourceType: "agent",
          },
          { state: harness.state },
        );
        const eventMessage = (eventKey: string) =>
          createEventInboundMessage({
            event: {
              eventKey,
              eventType: "deployment.failed",
              identifier: "getsentry/junior",
              namespace: "github",
              occurredAtMs: Date.now(),
              trustedSummary: "A deployment failed.",
            },
            subscription: { conversationId: childId, id: "watch-1" },
            text: "Deploy failed.",
          });
        if (legacyStart) {
          // The start that a release before `watchEventsOnly` wrote.
          const { inboundMessageId } = eventMessage("deploy-1");
          const turnId = buildDeterministicTurnId(inboundMessageId);
          await getConversationEventStore().append(childId, [
            {
              idempotencyKey: turnStartedKey(turnId),
              createdAtMs: Date.now(),
              data: {
                type: "turn_started",
                turnId,
                inputMessageIds: [inboundMessageId],
                surface: "api",
              },
            },
          ]);
        }
        const sendEvent = (eventKey: string) =>
          appendAndEnqueueInboundMessage({
            message: eventMessage(eventKey),
            queue: harness.queue,
            state: harness.state,
          });
        const before = await parentMessageTexts();
        const runsBefore = harness.runs.length;
        await sendEvent("deploy-1");
        vi.setSystemTime(Date.now() + 60_000);
        harness.onRun(async (run) => {
          const outcome = await finishRun(
            acked
              ? run
              : {
                  ...run,
                  durability: {
                    ...run.durability,
                    onInputCommitted: undefined,
                  },
                },
            { finalText: "The deploy is green." },
          );
          if (eventWaits && harness.runs.length === runsBefore + 1) {
            await sendEvent("deploy-2");
          }
          return outcome;
        });
        await harness.drain(childId);
        // The heartbeat wakes the Event that waited out its burst window.
        await runHeartbeatAfterLeasesExpire(harness.queue);
        await harness.drain(childId);

        expect(harness.runs.slice(runsBefore)).toEqual(
          Array.from({ length: eventWaits ? 2 : 1 }, () =>
            expect.objectContaining({
              conversationId: childId,
              source: expect.objectContaining({ kind: "event" }),
            }),
          ),
        );
        expect(
          (await parentMessageTexts())
            .slice(before.length)
            .filter((text) => text.includes("The deploy is green.")),
        ).toEqual(
          Array.from({ length: updates }, () =>
            expect.stringMatching(/status="done"/),
          ),
        );
        expect(
          (await parentMessageTexts()).filter((text) =>
            text.includes('source="watch"'),
          ),
        ).toEqual([]);
        expect(
          (await parentNoteTexts()).filter((text) =>
            text.includes("The deploy is green."),
          ),
        ).toEqual([]);
      } finally {
        await harness.close();
      }
    },
  );

  // The parent already watches the child agents it starts, so watching one
  // returns that Watch and stores no second one. Each update reaches the
  // parent once.
  it("gives the parent one update per child Turn through the Watch it got at the start", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "thread");
      const watchTool = createWatchEventsTool(
        { conversationId: slackParentConversationId } as ToolRuntimeContext,
        getEventCatalog(),
      );
      // A repeat call gets the same Watch.
      for (const call of [1, 2]) {
        await expect(
          watchTool.execute!(
            {
              events: ["agent.update"],
              identifier: childId,
              intent: "Tell the person how the deploy check ends.",
              label: "Deploy check",
              namespace: "junior",
              resource_type: "agent",
            },
            { toolCallId: `call-watch-${call}` },
          ),
        ).resolves.toMatchObject({
          events: ["agent.update"],
          id: `starter:${childId}`,
          subscription_status: "active",
        });
      }
      await expect(
        listWatches({
          conversationId: slackParentConversationId,
          state: harness.state,
        }),
      ).resolves.toEqual([]);

      const before = await parentMessageTexts();
      await sendPersonMessage(harness, childId, "person-1");
      harness.onRun((run) =>
        finishRun(run, { finalText: "The deploy is green." }),
      );
      await harness.drain(childId);

      expect(
        (await parentMessageTexts())
          .slice(before.length)
          .filter((text) => text.includes("The deploy is green.")),
      ).toEqual([expect.stringMatching(/^<agent-result [^>]*status="done"/)]);
    } finally {
      await harness.close();
    }
  });

  // A `noReply` end while the Thread's work goes on starts a Turn for each
  // Watch on the Thread, with the Thread's note, as it does for the starter.
  it("wakes a Watch on a Thread with the Thread's note when it ends with noReply", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "thread");
      await createDeployWatch(harness, childId);
      await createWatch(
        {
          conversationId: slackParentConversationId,
          events: ["agent.update"],
          expiresAtMs: Date.now() + 600_000,
          identifier: childId,
          intent: "Follow the deploy check.",
          label: "Deploy check thread",
          namespace: "junior",
          resourceType: "agent",
        },
        { state: harness.state },
      );
      const before = await parentMessageTexts();
      await sendPersonMessage(harness, childId, "person-1");
      harness.onRun((run) =>
        finishRun(run, { noReply: { note: "The deploy is green." } }),
      );
      await harness.drain(childId);

      expect(
        (await parentMessageTexts())
          .slice(before.length)
          .filter((text) => text.includes("The deploy is green.")),
      ).toEqual([
        expect.stringMatching(/^<agent-result [^>]*source="child_agent"/),
        expect.stringMatching(
          /^<task about="Deploy check thread"[\s\S]*<agent-result [^>]*source="watch"/,
        ),
      ]);
      expect(
        (await parentNoteTexts()).filter((text) =>
          text.includes("The deploy is green."),
        ),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  // A person's Turn in a Thread reports to the parent like an agent's Turn.
  // The person also sees its final text. Final text while a helper works is
  // a message, as a `reply` is. A `noReply` end reports also when a Watch is
  // left, and the parent decides. The parent runs it as the Event system
  // Actor, never as the person. The parent's listing shows how the person's
  // Turn ended.
  it.each([
    {
      end: "final text",
      openWork: "none",
      sent: "agent-result",
      lastResult: "done",
    },
    {
      end: "final text",
      openWork: "helper",
      sent: "agent-message",
      lastResult: "done",
    },
    {
      end: "noReply",
      openWork: "none",
      sent: "agent-result",
      lastResult: "done",
    },
    {
      end: "noReply",
      openWork: "Watch",
      sent: "agent-result",
      lastResult: "done",
    },
    {
      end: "blocked",
      openWork: "none",
      sent: "agent-result",
      lastResult: "blocked",
    },
  ] as const)(
    "reports a person's Turn in a Thread that ends with $end (open work: $openWork)",
    async ({ end, lastResult, openWork, sent }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, "thread");
        if (openWork === "Watch") {
          await createDeployWatch(harness, childId);
        } else if (openWork === "helper") {
          await createHelper(harness, childId);
        }
        const before = (await parentMessages()).length;
        await sendPersonMessage(harness, childId, "person-1");
        harness.onRun((run) =>
          finishRun(
            run,
            end === "final text"
              ? { finalText: "The deploy is green." }
              : end === "blocked"
                ? { blocked: { missing: "The deploy is green." } }
                : { noReply: { note: "The deploy is green." } },
          ),
        );
        await harness.drain(childId);

        expect(harness.runs.at(-1)).toMatchObject({
          conversationId: childId,
          source: { kind: "web" },
        });
        expect(
          (await parentMessages())
            .slice(before)
            .filter((message) =>
              message.input.text.includes("The deploy is green."),
            )
            .map((message) => ({
              authorId: message.input.authorId,
              tag: message.input.text.match(/<(agent-[a-z]+)/)?.[1],
            })),
        ).toEqual(
          sent
            ? [{ authorId: resultAuthorId(EVENT_SYSTEM_ACTOR), tag: sent }]
            : [],
        );
        const { agents } = (await createListAgentsTool({
          conversationId: slackParentConversationId,
        }).execute!({}, {})) as { agents: Array<{ last_result?: string }> };
        expect(agents[0]?.last_result).toBe(lastResult);
      } finally {
        await harness.close();
      }
    },
  );

  // A person's Turn in a Thread can start a helper, which runs as that
  // person. Its result runs in the Thread as the person, and the Thread's
  // result carries the person's Actor to the parent.
  it("passes a Thread helper's Actor through to the parent", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const harness = await createHarness();
    try {
      const childId = await startIdleChild(harness, "thread");
      const helper = await createHelper(harness, childId, {
        actor: webTestActor,
      });
      const before = (await parentMessages()).length;
      await sendHelperReply(harness, helper, webTestActor);
      harness.onRun((run) =>
        finishRun(run, { finalText: "The helper is done." }),
      );
      await harness.drain(childId);

      expect(harness.runs.at(-1)).toMatchObject({
        actor: webTestActor,
        conversationId: childId,
      });
      expect(
        (await parentMessages())
          .slice(before)
          .filter((message) =>
            message.input.text.includes("The helper is done."),
          )
          .map((message) => message.input.authorId),
      ).toEqual([resultAuthorId(webTestActor)]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { kind: "task", input: "helper reply" },
    { kind: "thread", input: "helper reply" },
    { kind: "thread", input: "person message" },
  ] as const)(
    "tells a $kind's parent when its Conversation loop Turn fails ($input)",
    async ({ kind, input }) => {
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const harness = await createHarness();
      try {
        const childId = await startIdleChild(harness, kind);
        const before = await parentMessageTexts();
        if (input === "helper reply") {
          await sendHelperReply(harness, await createHelper(harness, childId));
        } else {
          await sendPersonMessage(harness, childId, "person-message");
        }
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
        ).toEqual([expect.stringMatching(/status="failed"/)]);
        // The failure wins over the completed Turn before it.
        const listLastResult = async () =>
          (
            (await createListAgentsTool({
              conversationId: slackParentConversationId,
            }).execute!({}, {})) as { agents: Array<{ last_result?: string }> }
          ).agents[0]?.last_result;
        await expect(listLastResult()).resolves.toBe("failed");

        // A stopped Turn after the failure is not a result, so the failure
        // stays the child's result.
        harness.onRun(async (run) => {
          await storeConversationStop(run.conversationId);
          await run.durability?.checkStop?.();
          run.signal?.throwIfAborted();
          throw new Error("The stored stop did not abort the run");
        });
        await sendHelperReply(
          harness,
          await createHelper(harness, childId, {
            idempotencyKey: "helper-after-failure",
            parentToolCallId: "helper-after-failure",
          }),
        );
        await harness.processUntilRun(childId);
        await expect(loadTurnEvents(childId)).resolves.toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: "cancelled",
              type: "turn_completed",
            }),
          }),
        );
        await expect(listLastResult()).resolves.toBe("failed");
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
      // The listing keeps the result of the task Turn before the stop.
      const { agents } = (await createListAgentsTool({
        conversationId: slackParentConversationId,
      }).execute!({}, {})) as { agents: Array<{ last_result?: string }> };
      expect(agents[0]?.last_result).toBe("done");
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
