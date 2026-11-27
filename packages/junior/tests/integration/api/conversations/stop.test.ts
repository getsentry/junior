import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  getConversationStoppedAtMs,
  resumeConversationTree,
  stopConversationTree,
} from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { getConversationEventStore } from "@/chat/db";
import { isEventMailboxMetadata } from "@/chat/events/mailbox-metadata";
import {
  ackMessages,
  completeConversationWork,
  getConversationWorkState,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  abortableAgentRunner,
  expectChildAgentStopped,
  spawnInput,
  spawnChildAgent,
  startRunningChildAgent,
  createPublishChildTurn,
} from "../../../fixtures/child-agents";
import { startChildAgent } from "../../../fixtures/child-agent-start";
import {
  createConversationWorkHarness,
  deferred,
} from "../../../fixtures/conversation-work";
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

  it("holds a child result that waits when a person stops the parent", async () => {
    const rootRuns: AgentRun[] = [];
    const work = await createConversationWorkHarness({
      run: async (run) => {
        if (run.parentConversationId) {
          return await finishRun(run, { finalText: "Child finding: 42." });
        }
        rootRuns.push(run);
        return await finishRun(run, { finalText: "Asked a helper." });
      },
    });
    const fixture = {
      ...(await createConversationFixture()),
      queue: work.queue,
    };
    const { actor, conversationStore, queue, state } = fixture;
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "stop-result-root",
        message: "Find the number.",
      },
      { conversationStore, queue, state },
    );
    await work.process(queue.takeMessageFor(created.conversationId));
    const child = await spawnChildAgent({
      conversationStore,
      idempotencyKey: "stop-result-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    // The child's Turn replies to the parent, and the parent has not read
    // the reply yet.
    await work.process(queue.takeMessageFor(child.childConversationId));

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    // The stop holds the reply, so no parent Turn runs for it.
    await expect(
      work.process(queue.takeMessageFor(created.conversationId)),
    ).resolves.toMatchObject({ status: "no_work" });

    // The person's next message ends the stop. Its Turn reads the reply.
    await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "after-stop",
        message: "What did the helper find?",
      },
      { conversationStore, queue, state },
    );
    await work.process(queue.takeMessageFor(created.conversationId));
    expect(rootRuns).toHaveLength(2);
    expect(rootRuns[1]!.instruction.context).toContain("Child finding: 42.");
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
