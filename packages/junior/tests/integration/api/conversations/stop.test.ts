import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createAcpConversations } from "@/api/acp/conversations";
import { enqueueAgentInvocationResult } from "@/chat/agent-invocations/result";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { stopChildAgentsOf } from "@/chat/agent-invocations/stop";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import { getAgentInvocationResultMessageId } from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import type { TerminalAgentInvocation } from "@/chat/agent-invocations/types";
import { stopConversationTurnResponseSchema } from "@/api/schema";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { legacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import {
  getConversationStoppedAtMs,
  resumeStoppedConversationTree,
} from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { getConversationEventStore } from "@/chat/db";
import { isEventMailboxMetadata } from "@/chat/events/notification";
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
  invocationInput,
  loadTurnEvents,
  spawnChildAgent,
  startRunningChildAgent,
} from "../../../fixtures/agent-invocations";
import { neverRunAgentRunner } from "../../../fixtures/agent-runner";
import {
  createConversationWorkHarness,
  deferred,
} from "../../../fixtures/conversation-work";
import { testViewer } from "../../../fixtures/user";

function stopRequest(
  fixture: ConversationFixture,
  conversationId: string,
  email: string,
) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
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
    const otherActor = webActorFromUser(testViewer("bob@example.com"));
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
    expect(stranger.status).toBe(403);

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
    const fixture = await createConversationFixture();
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
    const doneResult = (await completeAgentInvocation({
      invocationId: done.invocationId,
      result: "Child fact: 42.",
      status: "completed",
    })) as TerminalAgentInvocation;
    await enqueueAgentInvocationResult(doneResult, { queue, state });
    await ackMessages({
      conversationId: created.conversationId,
      conversationStore,
      inboundMessageIds: [getAgentInvocationResultMessageId(done.invocationId)],
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
    // A stop keeps a result that the parent already read. The child's
    // session still ends, so no watch or queued input starts it again.
    await expect(getAgentInvocation(done.invocationId)).resolves.toMatchObject({
      parentMailboxStatus: "appended",
      status: "completed",
    });
    await expect(
      listChildAgents(created.conversationId),
    ).resolves.toContainEqual(
      expect.objectContaining({
        childConversationId: done.childConversationId,
        lastResult: "completed",
      }),
    );
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
        user: testViewer(actor.email),
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
    const helper = await createAgentInvocation({
      ...invocationInput,
      idempotencyKey: "stop-child-helper",
      parentConversationId: child.childConversationId,
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

    await expect(getAgentInvocation(child.invocationId)).resolves.toMatchObject(
      {
        errorMessage: "Agent invocation was stopped",
        parentMailboxStatus: "appended",
        status: "stopped",
      },
    );
    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual(["agent_invocation.stopped"]);
    await expect(
      getAgentInvocation(helper.invocationId),
    ).resolves.toMatchObject({
      parentMailboxStatus: "skipped",
      status: "stopped",
    });
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
    await resumeStoppedConversationTree(
      created.conversationId,
      rootStopAtMs + 1,
    );
    for (const conversationId of [
      child.childConversationId,
      helper.childConversationId,
    ]) {
      await expect(getConversationStoppedAtMs(conversationId)).resolves.toBe(
        childStoppedAtMs,
      );
    }
  });

  it("starts no parent Turn for a child result that waits when a person stops the parent", async () => {
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
    const result = (await completeAgentInvocation({
      invocationId: child.invocationId,
      result: "Child fact: 42.",
      status: "completed",
    })) as TerminalAgentInvocation;
    await enqueueAgentInvocationResult(result, { queue, state });
    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual(["agent_invocation.completed"]);

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    await expect(
      work.process(queue.takeMessageFor(created.conversationId)),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      parentMailboxEventTypes(created.conversationId, state),
    ).resolves.toEqual([]);
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
    const grandchild = await createAgentInvocation({
      ...invocationInput,
      idempotencyKey: "late-cascade-grandchild",
      parentConversationId: child.invocation.childConversationId,
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
    await stopChildAgentsOf(child.invocation.childConversationId, state);
    await expect(
      getConversationStoppedAtMs(grandchild.childConversationId),
    ).resolves.toBe(stoppedAtMs);

    // After a person's input to the root ends the stop of the tree, a late
    // cascade does not stop the grandchild again.
    clock.mockReturnValue(clock() + 1_000);
    await resumeStoppedConversationTree(created.conversationId, clock());
    clock.mockReturnValue(clock() + 1_000);
    await stopChildAgentsOf(child.invocation.childConversationId, state);
    await expect(
      getConversationStoppedAtMs(grandchild.childConversationId),
    ).resolves.toBeUndefined();
  });

  it("stops a child agent that a stopped child agent spawned before its run saw the stop", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const { created } = await startParentTurn(fixture, "missed-spawn-root");
    const child = await startRunningChildAgent({
      conversationStore,
      idempotencyKey: "missed-spawn-child",
      parentConversationId: created.conversationId,
      queue,
      state,
    });
    const response = await stopRequest(
      fixture,
      child.invocation.childConversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    const stoppedAtMs = clock();

    // The child's run spawns a child agent before it sees the stop, and that
    // child agent finishes. When the run sees the stop, its cascade still
    // stops that child agent, with the child's stop.
    clock.mockReturnValue(clock() + 1_000);
    const missed = await createAgentInvocation({
      ...invocationInput,
      idempotencyKey: "missed-spawn-grandchild",
      parentConversationId: child.invocation.childConversationId,
    });
    await completeAgentInvocation({
      invocationId: missed.invocationId,
      result: "Missed fact: 42.",
      status: "completed",
    });
    clock.mockReturnValue(clock() + 1_000);
    await stopChildAgentsOf(child.invocation.childConversationId, state);
    await expect(
      getConversationStoppedAtMs(missed.childConversationId),
    ).resolves.toBe(stoppedAtMs);
  });

  it("stops a child agent that a stopped root spawned before its run saw the stop", async () => {
    const started = deferred();
    const toolCallDone = deferred();
    // The root's run is in a long tool call when the stop comes. It sees the
    // stop only when that call returns.
    const work = await createConversationWorkHarness({
      run: async (run) => {
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
    });
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
    // The root already read the result of a child agent that finished.
    const read = await createAgentInvocation({
      ...invocationInput,
      idempotencyKey: "late-root-read-child",
      parentConversationId: created.conversationId,
    });
    const lease = await startConversationWork({
      conversationId: created.conversationId,
      conversationStore,
      state,
    });
    if (lease.status !== "acquired") throw new Error("Expected work lease");
    await enqueueAgentInvocationResult(
      (await completeAgentInvocation({
        invocationId: read.invocationId,
        result: "Read fact: 42.",
        status: "completed",
      })) as TerminalAgentInvocation,
      { queue, state },
    );
    await ackMessages({
      conversationId: created.conversationId,
      conversationStore,
      inboundMessageIds: [getAgentInvocationResultMessageId(read.invocationId)],
      leaseToken: lease.leaseToken,
      state,
    });
    await completeConversationWork({
      conversationId: created.conversationId,
      conversationStore,
      leaseToken: lease.leaseToken,
      state,
    });
    const processing = work.process(
      queue.takeMessageFor(created.conversationId),
    );
    await started.promise;
    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);

    // The tool call spawns a child agent after the stop.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const missed = await createAgentInvocation({
      ...invocationInput,
      idempotencyKey: "late-root-spawn-child",
      parentConversationId: created.conversationId,
    });
    toolCallDone.resolve();
    await expect(processing).resolves.toMatchObject({ status: "completed" });

    await expect(
      getAgentInvocation(missed.invocationId),
    ).resolves.toMatchObject({ status: "stopped" });
    await expect(
      getConversationStoppedAtMs(missed.childConversationId),
    ).resolves.toBeDefined();
    // The late cascade keeps the result that the root already read.
    await expect(getAgentInvocation(read.invocationId)).resolves.toMatchObject({
      parentMailboxStatus: "appended",
      status: "completed",
    });
    await expect(
      listChildAgents(created.conversationId),
    ).resolves.toContainEqual(
      expect.objectContaining({
        childConversationId: read.childConversationId,
        lastResult: "completed",
      }),
    );
    // A person's input to the root ends the stop of that child agent too.
    await resumeStoppedConversationTree(created.conversationId, Date.now());
    await expect(
      getConversationStoppedAtMs(missed.childConversationId),
    ).resolves.toBeUndefined();
  });
});
