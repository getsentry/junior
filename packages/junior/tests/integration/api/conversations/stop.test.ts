import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createAcpConversations } from "@/api/acp/conversations";
import { stopChildAgentsOf } from "@/chat/child-agents/stop";
import { getAgentReplyMessageId } from "@/chat/child-agents/ids";
import { stopConversationTurnResponseSchema } from "@/api/schema";
import type { AgentRun } from "@/chat/agent/types";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { legacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import { stopConversationTree } from "@/chat/conversations/session-stop";
import {
  getConversationStoppedAtMs,
  resumeConversationTree,
} from "@/chat/conversations/stop-state";
import { stopConversation } from "@/chat/conversations/stop";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { createEngineContext } from "@/turn-steps/engine-context";
import { turnStepConsumer } from "@/turn-steps/consumer";
import { getChatConfig } from "@/chat/config";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getConversationEventStore, getDb } from "@/chat/db";
import { createEventInboundMessage } from "@/chat/events/notification";
import { juniorTurns } from "@/db/schema";
import { getQueueProvider } from "@/chat/queue/provider";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import {
  ackMessages,
  appendAndEnqueueInboundMessage,
  completeConversationWork,
  getConversationWorkState,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  closeConversationFixture,
  createConversationFixture,
  stoppedConversationMessageTexts,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  abortableAgentRunner,
  expectChildAgentStopped,
  spawnInput,
  loadTurnEvents,
  spawnChildAgent,
  startRunningChildAgent,
  createPublishChildTurn,
} from "../../../fixtures/child-agents";
import { neverRunAgentRunner } from "../../../fixtures/agent-runner";
import { startChildAgent } from "../../../fixtures/child-agent-start";
import {
  createConversationWorkHarness,
  deferred,
} from "../../../fixtures/conversation-work";
import { patchConfig } from "../../../fixtures/config";
import { fakeModelClient } from "../../../fixtures/model-stream";
import { staticTools } from "../../../fixtures/turn-engine";
import { finishRun } from "../../../fixtures/thread-input";
import { signedInViewer } from "../../../fixtures/user";

function stopRequest(
  fixture: ConversationFixture,
  conversationId: string,
  email: string,
) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/stop`,
    { method: "POST" },
  );
}

/** List the event types of the child agent input in a parent mailbox. */
async function parentMailboxEventTypes(
  conversationId: string,
  state: ConversationFixture["state"],
): Promise<string[]> {
  const messages =
    (await getConversationWorkState({ conversationId, state }))?.messages ?? [];
  return messages.flatMap((message) => {
    const metadata = message.input.metadata;
    return isEventMailboxMetadata(metadata) ? [metadata.event.eventType] : [];
  });
}

/** Start a web Turn that already took its input and still holds its lease. */
async function startParentTurn(
  fixture: ConversationFixture,
  idempotencyKey: string,
) {
  const { actor, conversationStore, queue, state } = fixture;
  const created = await createAndEnqueueConversation(
    { actor, idempotencyKey, message: "Start a long Turn." },
    { conversationStore, queue, state },
  );
  const lease = await startConversationWork({
    conversationId: created.conversationId,
    conversationStore,
    state,
  });
  if (lease.status !== "acquired") throw new Error("Expected work lease");
  await ackMessages({
    conversationId: created.conversationId,
    conversationStore,
    inboundMessageIds: [created.messageId],
    leaseToken: lease.leaseToken,
    state,
  });
  return { created, leaseToken: lease.leaseToken };
}

/**
 * Run each Turn in a long tool call that sees a stop only when it returns,
 * like a run whose tool call spawns a child agent while the stop comes.
 */
function lateStopRunner() {
  const started = deferred();
  const toolCallDone = deferred();
  return {
    agentRunner: {
      run: async (run: AgentRun): Promise<never> => {
        started.resolve();
        await toolCallDone.promise;
        const signal = run.signal!;
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        }
        throw signal.reason;
      },
    },
    started,
    toolCallDone,
  };
}

describe("conversation stop API", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeConversationFixture();
  });

  it("stops the active Turn and its child agents and returns only the viewer's queued text", async () => {
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "stop-root");
    const child = await startRunningChildAgent({
      conversationStore,
      idempotencyKey: "stop-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const queued = await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "stop-queued",
        message: "Queued while running.",
      },
      { conversationStore, queue, state },
    );
    // Input queued before web Actors used the User id stores the legacy id.
    const legacyQueued = await appendAndEnqueueWebMessage(
      {
        actor: { ...actor, userId: legacyWebActorUserId(actor.email) },
        conversationId: created.conversationId,
        idempotencyKey: "stop-queued-legacy",
        message: "Queued before the deploy.",
      },
      { conversationStore, queue, state },
    );
    const otherActor = webActorFromUser(
      await signedInViewer("bob@example.com"),
    );
    const otherQueued = await appendAndEnqueueWebMessage(
      {
        actor: otherActor,
        conversationId: created.conversationId,
        idempotencyKey: "stop-queued-other",
        message: "Bob's queued note.",
      },
      { conversationStore, queue, state },
    );

    const stranger = await stopRequest(
      fixture,
      created.conversationId,
      "stranger@example.com",
    );
    expect(stranger.status).toBe(404);

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    expect(
      stopConversationTurnResponseSchema.parse(await response.json()),
    ).toEqual({
      conversationId: created.conversationId,
      status: "requested",
      stoppedInboundMessageIds: [
        queued.messageId,
        legacyQueued.messageId,
        otherQueued.messageId,
      ],
      stoppedMessages: [
        { inboundMessageId: queued.messageId, text: "Queued while running." },
        {
          inboundMessageId: legacyQueued.messageId,
          text: "Queued before the deploy.",
        },
      ],
    });
    await expectChildAgentStopped(child, state);
  });

  it("stops child agents that still run after the parent Turn ended", async () => {
    const work = await createConversationWorkHarness({ run: finishRun });
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { actor, conversationStore, queue, state } = fixture;
    const { created, leaseToken } = await startParentTurn(
      fixture,
      "stop-idle-root",
    );
    // The parent Turn already read the result of this child.
    const done = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "stop-idle-done-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    // Its Turn took its task and replied.
    await work.process(queue.takeMessageFor(done.childConversationId));
    await createPublishChildTurn({ queue, state })({
      actor: spawnInput.actor,
      conversationId: done.childConversationId,
      update: { status: "done", text: "Child fact: 42." },
      turnId: "turn_done-child",
    });
    await ackMessages({
      conversationId: created.conversationId,
      conversationStore,
      inboundMessageIds: [
        getAgentReplyMessageId(done.childConversationId, "turn_done-child"),
      ],
      leaseToken,
      state,
    });
    await completeConversationWork({
      conversationId: created.conversationId,
      conversationStore,
      leaseToken,
      state,
    });
    const child = await startRunningChildAgent({
      conversationStore,
      idempotencyKey: "stop-idle-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    expect(
      stopConversationTurnResponseSchema.parse(await response.json()),
    ).toMatchObject({ status: "no_work" });
    await expectChildAgentStopped(child, state);
    await expect(
      getConversationStoppedAtMs(created.conversationId),
    ).resolves.toBeDefined();
    // The finished child's session ends too, so no watch or queued input
    // starts it again.
    await expect(
      getConversationStoppedAtMs(done.childConversationId),
    ).resolves.toBeDefined();
  });

  it("stops child agents when an ACP client cancels the parent Turn", async () => {
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "acp-stop-root");
    const child = await startRunningChildAgent({
      conversationStore,
      idempotencyKey: "acp-stop-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const conversations = createAcpConversations({
      conversationStore,
      eventStore: getConversationEventStore(),
      queue,
      state,
    });

    await expect(
      conversations.cancel({
        conversationId: created.conversationId,
        user: await signedInViewer(actor.email),
      }),
    ).resolves.toBe("cancelled");
    await expectChildAgentStopped(child, state);
    await expect(
      getConversationStoppedAtMs(created.conversationId),
    ).resolves.toBeDefined();
  });

  it("reports a person's stop of a child agent to its parent and stops the agents below it", async () => {
    const runner = abortableAgentRunner();
    const work = await createConversationWorkHarness(runner.agentRunner);
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { actor, conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "stop-child-root");
    const child = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "stop-child-directly",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const helper = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "stop-child-helper",
      parentConversationId: child.childConversationId,
      queue,
      state,
    });
    const processing = work.process(
      queue.takeMessageFor(child.childConversationId),
    );
    await runner.started();

    // Access to a child agent Conversation comes from its root.
    const response = await stopRequest(
      fixture,
      child.childConversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    expect(
      stopConversationTurnResponseSchema.parse(await response.json()),
    ).toMatchObject({ status: "requested" });
    await expect(processing).resolves.toMatchObject({ status: "completed" });

    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual(["agent.update"]);
    const [stopped] =
      (
        await getConversationWorkState({
          conversationId: created.conversationId,
          state,
        })
      )?.messages ?? [];
    expect(stopped?.input.text).toMatch(/^<agent-result [^>]*status="stopped"/);
    // The stop ends the sessions of the child and the agents below it, but
    // not of its parent.
    await expect(
      getConversationStoppedAtMs(child.childConversationId),
    ).resolves.toBeDefined();
    const childStoppedAtMs = await getConversationStoppedAtMs(
      child.childConversationId,
    );
    expect(childStoppedAtMs).toBeDefined();
    await expect(
      getConversationStoppedAtMs(helper.childConversationId),
    ).resolves.toBe(childStoppedAtMs);
    await expect(
      getConversationStoppedAtMs(created.conversationId),
    ).resolves.toBeUndefined();

    // A late stop message for the root was sent before the child's stop. The
    // child keeps its later stop, also after input ends the root's stop.
    const rootStopAtMs = childStoppedAtMs! - 1_000;
    await stopConversation({
      conversationId: created.conversationId,
      conversationStore,
      message: {
        conversationId: created.conversationId,
        createdAtMs: rootStopAtMs,
        inboundMessageId: "late-root-stop",
        source: "web",
      },
      queue,
      state,
    });
    await expect(
      getConversationStoppedAtMs(created.conversationId),
    ).resolves.toBe(rootStopAtMs);
    await resumeConversationTree(created.conversationId, rootStopAtMs + 1);
    for (const conversationId of [
      child.childConversationId,
      helper.childConversationId,
    ]) {
      await expect(getConversationStoppedAtMs(conversationId)).resolves.toBe(
        childStoppedAtMs,
      );
    }
  });

  it("drops a child result that waits when a person stops the parent", async () => {
    const work = await createConversationWorkHarness(neverRunAgentRunner());
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { actor, conversationStore, queue, state } = fixture;
    const { created, leaseToken } = await startParentTurn(
      fixture,
      "stop-result-root",
    );
    await completeConversationWork({
      conversationId: created.conversationId,
      conversationStore,
      leaseToken,
      state,
    });
    const child = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "stop-result-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    await createPublishChildTurn({ queue, state })({
      actor: spawnInput.actor,
      conversationId: child.childConversationId,
      update: { status: "blocked", text: "Child needs a token." },
      turnId: "turn_blocked-child",
    });
    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual(["agent.update"]);

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    // The stop also stops the child, so the parent gets no result from it,
    // and nothing is left to run.
    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual([]);
    await expect(
      stoppedConversationMessageTexts(created.conversationId),
    ).resolves.toEqual([]);
    await expect(
      work.process(queue.takeMessageFor(created.conversationId)),
    ).resolves.toMatchObject({ status: "no_work" });
    await expect(loadTurnEvents(created.conversationId)).resolves.toEqual([]);
  });

  it("keeps the stop below a child agent when its run sees the stop late", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "late-cascade-root");
    const child = await startRunningChildAgent({
      conversationStore,
      idempotencyKey: "late-cascade-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const grandchild = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "late-cascade-grandchild",
      parentConversationId: child.child.childConversationId,
      queue,
      state,
    });
    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    const stoppedAtMs = clock();
    await expect(
      getConversationStoppedAtMs(grandchild.childConversationId),
    ).resolves.toBe(stoppedAtMs);

    // The child's run sees the stop later and stops its own child agents.
    // That does not move the stop of a Conversation that is already stopped.
    clock.mockReturnValue(clock() + 1_000);
    await stopChildAgentsOf(child.child.childConversationId, state);
    await expect(
      getConversationStoppedAtMs(grandchild.childConversationId),
    ).resolves.toBe(stoppedAtMs);

    // After a person's input to the root ends the stop of the tree, a late
    // cascade does not stop the grandchild again.
    clock.mockReturnValue(clock() + 1_000);
    await resumeConversationTree(created.conversationId, clock());
    clock.mockReturnValue(clock() + 1_000);
    await stopChildAgentsOf(child.child.childConversationId, state);
    await expect(
      getConversationStoppedAtMs(grandchild.childConversationId),
    ).resolves.toBeUndefined();
  });

  it("stops a child agent that a stopped child agent spawned before its run saw the stop", async () => {
    const lateStop = lateStopRunner();
    const work = await createConversationWorkHarness(lateStop.agentRunner);
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "missed-spawn-root");
    const { childConversationId } = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "missed-spawn-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const processing = work.process(queue.takeMessageFor(childConversationId));
    await lateStop.started.promise;
    const stoppedAtMs = Date.now();
    // The tool call's spawn raced the stop of the child: the stop read the
    // tree before the spawn committed, so it reached only the child.
    const missed = await startChildAgent({
      actor: spawnInput.actor,
      conversationStore,
      idempotencyKey: "missed-spawn-grandchild",
      nowMs: stoppedAtMs + 1_000,
      parentConversationId: childConversationId,
      queue,
      state,
    });
    queue.takeMessageFor(missed);
    await stopConversationTree([childConversationId], {
      queue,
      state,
      stoppedAtMs,
    });
    lateStop.toolCallDone.resolve();
    // When the child's run sees the stop, its cascade still stops that child
    // agent, with the child's stop.
    await expect(processing).resolves.toMatchObject({ status: "completed" });
    await expect(getConversationStoppedAtMs(missed)).resolves.toBe(stoppedAtMs);
  });

  it("stops a child agent that a stopped root spawned before its run saw the stop", async () => {
    const lateStop = lateStopRunner();
    const work = await createConversationWorkHarness(lateStop.agentRunner);
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { actor, conversationStore, queue, state } = fixture;
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "late-root-spawn",
        message: "Start a long Turn.",
      },
      { conversationStore, queue, state },
    );
    const processing = work.process(
      queue.takeMessageFor(created.conversationId),
    );
    await lateStop.started.promise;
    const stoppedAtMs = Date.now();
    // The tool call's spawn raced the stop: the stop read the tree before
    // the spawn committed, so it reached only the root.
    const missed = await startChildAgent({
      actor: spawnInput.actor,
      conversationStore,
      idempotencyKey: "late-root-spawn-child",
      nowMs: stoppedAtMs + 1_000,
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    queue.takeMessageFor(missed);
    await stopConversationTree([created.conversationId], {
      queue,
      state,
      stoppedAtMs,
    });
    lateStop.toolCallDone.resolve();
    await expect(processing).resolves.toMatchObject({ status: "completed" });

    await expect(getConversationStoppedAtMs(missed)).resolves.toBe(stoppedAtMs);
    // A person's input to the root ends the stop of that child agent too.
    await resumeConversationTree(created.conversationId, stoppedAtMs + 2_000);
    await expect(getConversationStoppedAtMs(missed)).resolves.toBeUndefined();
  });
});

describe("conversation stop API on the core Turn engine", () => {
  // Core publishes each Turn message to Vercel Queues. The server keeps them
  // with no consumer, so the Turns stay queued until the stop.
  let queueServer: LocalVercelQueueServer;

  beforeAll(async () => {
    queueServer = await startLocalVercelQueueServer({ consumers: [] });
  });

  afterAll(async () => {
    await queueServer.close();
  });

  afterEach(async () => {
    await closeConversationFixture();
  });

  it("drops an Event sent after a timed stop's cutoff, so the core Turns stay stopped", async () => {
    patchConfig({
      turnEngine: "core",
      queue: { ...getChatConfig().queue, apiUrl: queueServer.url.href },
    });
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "core-timed-stop",
        message: "Check the deploy.",
      },
      { conversationStore, queue, state },
    );
    const stoppedAtMs = Date.now();
    await appendAndEnqueueInboundMessage({
      message: createEventInboundMessage({
        event: {
          eventKey: "checks-failed-1",
          eventType: "pull_request.checks.failed",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: stoppedAtMs + 1_000,
          trustedSummary: "The subscribed check failed.",
        },
        subscription: { conversationId: created.conversationId, id: "watch-1" },
        text: "The subscribed check failed.",
      }),
      queue,
      state,
    });

    await stopConversationTree([created.conversationId], {
      queue,
      sentAtOrBeforeMs: stoppedAtMs,
      state,
      stoppedAtMs,
    });

    const turns = await getDb()
      .select({ state: juniorTurns.state })
      .from(juniorTurns)
      .where(eq(juniorTurns.conversationId, created.conversationId));
    expect(turns.map((turn) => turn.state)).not.toContain("queued");
    await expect(
      getConversationStoppedAtMs(created.conversationId),
    ).resolves.toBe(stoppedAtMs);
  });

  it("returns the viewer's queued text from the core Turns it stops, and a second stop finds no work", async () => {
    patchConfig({
      turnEngine: "core",
      queue: { ...getChatConfig().queue, apiUrl: queueServer.url.href },
    });
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const created = await createAndEnqueueConversation(
      { actor, idempotencyKey: "core-stop-root", message: "Check the deploy." },
      { conversationStore, queue, state },
    );
    const otherQueued = await appendAndEnqueueWebMessage(
      {
        actor: webActorFromUser(await signedInViewer("bob@example.com")),
        conversationId: created.conversationId,
        idempotencyKey: "core-stop-other",
        message: "Bob's queued note.",
      },
      { conversationStore, queue, state },
    );
    const stop = async () =>
      stopConversationTurnResponseSchema.parse(
        await (
          await stopRequest(fixture, created.conversationId, actor.email)
        ).json(),
      );

    await expect(stop()).resolves.toEqual({
      conversationId: created.conversationId,
      status: "requested",
      stoppedInboundMessageIds: [created.messageId, otherQueued.messageId],
      stoppedMessages: [
        { inboundMessageId: created.messageId, text: "Check the deploy." },
      ],
    });
    await expect(stop()).resolves.toEqual({
      conversationId: created.conversationId,
      status: "no_work",
      stoppedInboundMessageIds: [],
      stoppedMessages: [],
    });
  });

  it("does not return the input that the running core Turn already shows in the transcript", async () => {
    patchConfig({
      turnEngine: "core",
      queue: { ...getChatConfig().queue, apiUrl: queueServer.url.href },
    });
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    // The queue server has no consumer, so the test runs the step itself
    // with the message that core sent.
    const send = vi.spyOn(getQueueProvider(), "send");
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "core-stop-claimed",
        message: "Check the deploy.",
      },
      { conversationStore, queue, state },
    );
    const [, stepMessage] = send.mock.calls.find(
      ([topic]) => topic === TURN_STEP_TOPIC,
    )!;
    let queued: Awaited<ReturnType<typeof appendAndEnqueueWebMessage>>;
    let stopped: unknown;
    const model = fakeModelClient([{ type: "text", text: "Too late." }]);
    const step = await turnStepConsumer(createEngineContext(getChatConfig()), {
      client: {
        // The step has claimed its input and shown it when the model runs.
        complete: async (request, signal) => {
          queued = await appendAndEnqueueWebMessage(
            {
              actor,
              conversationId: created.conversationId,
              idempotencyKey: "core-stop-queued",
              message: "Also check the canary.",
            },
            { conversationStore, queue, state },
          );
          stopped = await (
            await stopRequest(fixture, created.conversationId, actor.email)
          ).json();
          return model.complete(request, signal);
        },
      },
      bot: getChatConfig().bot,
      tools: staticTools([]),
    });

    await step.handler(stepMessage, {
      consumerGroup: "test",
      createdAt: new Date(),
      deliveryCount: 1,
      messageId: "core-stop-claimed-step",
      topicName: TURN_STEP_TOPIC,
    });

    expect(
      projectConversationMessages(
        await getConversationEventStore().loadMessageHistory(
          created.conversationId,
        ),
      ).map((message) => message.text),
    ).toEqual(["Check the deploy."]);
    expect(stopConversationTurnResponseSchema.parse(stopped)).toEqual({
      conversationId: created.conversationId,
      status: "requested",
      stoppedInboundMessageIds: [queued!.messageId],
      stoppedMessages: [
        { inboundMessageId: queued!.messageId, text: "Also check the canary." },
      ],
    });
  });
});
