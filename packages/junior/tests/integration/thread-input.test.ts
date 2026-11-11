import {
  createSlackSource,
  createWebSource,
  type Source,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { createAgentInvocationForMessage } from "@/chat/agent-invocations/create";
import { getAgentInvocationTurnId } from "@/chat/agent-invocations/ids";
import {
  getAgentInvocation,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { buildPromptInput } from "@/chat/agent/prompt";
import { type AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { openConversationProjection } from "@/chat/conversations/projection";
import { getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  getTurnRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { recordTurnAuthorization } from "@/chat/task-execution/authorized-turn";
import { getAuthPausedConversationTurnId } from "@/chat/task-execution/mailbox-turn";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  getConversationWorkState,
  releaseConversationWork,
  requestAnotherSlice,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { juniorDestinations } from "@/db/schema";
import {
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { webTestActor } from "../fixtures/conversation";
import {
  createHarness,
  finishInvocation,
  sendPersonMessage,
  savePersonTurn,
  startThread,
  type Harness,
} from "../fixtures/thread-input";

/** Give the Thread more work from its parent agent, like messageAgent. */
async function sendParentMessage(harness: Harness, toolCallId: string) {
  const parentRun: AgentRun = {
    actor: slackInvocationInput.actor,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    instruction: { text: "Coordinate the work." },
    source: createSlackSource({
      channelId: "C123",
      teamId: "T123",
      threadTs: "1712345.0001",
      visibility: "public",
    }),
    turnId: "parent-turn",
  };
  await createMessageAgentTool(
    bindMessageAgent(parentRun, {
      queue: harness.queue,
      state: harness.state,
    })!,
  ).execute!(
    { text: "Also check the retry path.", to: "researcher" },
    {
      toolCallId,
    },
  );
}

/**
 * Save the slice that a parent's Agent invocation leaves after it took its
 * input: `running` when its worker died, `paused` when it yielded. An
 * invocation that a web Turn started keeps that Turn's web Source.
 */
async function saveInvocationSlice(
  threadId: string,
  mode: "paused" | "running",
  source: Source = { kind: "agent_invocation" },
): Promise<string> {
  const { invocation } = await createAgentInvocationForMessage({
    actor: slackInvocationInput.actor,
    childConversationId: threadId,
    destination: slackDestination,
    idempotencyKey: "thread-next",
    input: "Also check the retry path.",
    parentConversationId: slackParentConversationId,
    parentToolCallId: "call-next",
  });
  await markAgentInvocationRunning(invocation.invocationId);
  const history = (
    await openConversationProjection({ conversationId: threadId })
  ).messages;
  const slice = {
    actor: slackInvocationInput.actor,
    conversationId: threadId,
    destination: slackDestination,
    messages: [
      ...history,
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Also check the retry path." },
        ],
        timestamp: Date.now(),
      },
    ],
    sliceId: 1,
    source,
    surface: "internal" as const,
    turnId: getAgentInvocationTurnId(invocation.invocationId),
  };
  await saveTurnCheckpoint(
    mode === "paused"
      ? { ...slice, mode, reason: "yield" }
      : { ...slice, mode },
  );
  await expect(getTurnRecord(threadId, slice.turnId)).resolves.toMatchObject({
    state: mode,
  });
  return invocation.invocationId;
}

/** Record the person's sign-in and send its one empty wake, as OAuth does. */
async function signInAndWake(
  harness: Harness,
  threadId: string,
  turnId: string,
) {
  const request = await recordTurnAuthorization({
    actorId: "U123",
    authorizationId: "authorization-1",
    conversationId: threadId,
    destination: slackDestination,
    kind: "plugin",
    provider: "github",
    turnId,
  });
  if (!request) throw new Error("Expected a sign-in wake request");
  await wakePausedTurn(request, {
    conversationStore: harness.conversationStore,
    queue: harness.queue,
    state: harness.state,
  });
}

/** Leave work paused for its next slice, as a worker does when its Turn yields. */
async function yieldThreadWork(harness: Harness, threadId: string) {
  await requestConversationWork({
    conversationId: threadId,
    destination: undefined,
    state: harness.state,
  });
  const lease = await startConversationWork({
    conversationId: threadId,
    state: harness.state,
  });
  if (lease.status !== "acquired") throw new Error("Expected a work lease");
  const args = {
    conversationId: threadId,
    destination: undefined,
    leaseToken: lease.leaseToken,
    state: harness.state,
  };
  await requestAnotherSlice(args);
  await releaseConversationWork(args);
}

/** Leave the expired lease of a worker that died mid-Turn. */
async function leaveExpiredLease(harness: Harness, threadId: string) {
  const startedAtMs = Date.now() - CONVERSATION_WORK_LEASE_TTL_MS - 1_000;
  await requestConversationWork({
    conversationId: threadId,
    destination: undefined,
    nowMs: startedAtMs,
    state: harness.state,
  });
  const lease = await startConversationWork({
    conversationId: threadId,
    nowMs: startedAtMs,
    state: harness.state,
  });
  if (lease.status !== "acquired") throw new Error("Expected a work lease");
}

/** Expire the lease of a worker that died mid-Turn, as the heartbeat does. */
async function expireLostWorker(harness: Harness, threadId: string) {
  await leaveExpiredLease(harness, threadId);
  await recoverConversationWork({
    nowMs: Date.now(),
    queue: harness.queue,
    state: harness.state,
  });
}

/** Read the event types that the parent got for one Agent invocation. */
async function readParentResults(harness: Harness, invocationId: string) {
  const work = await getConversationWorkState({
    conversationId: slackParentConversationId,
    state: harness.state,
  });
  return (work?.messages ?? []).flatMap((message) => {
    const event = message.input.metadata?.event as
      | { eventType?: string; identifier?: string }
      | undefined;
    return event?.identifier === invocationId && event.eventType
      ? [event.eventType]
      : [];
  });
}

/** End an Agent invocation run as blocked on a sign-in it cannot ask for. */
async function endBlocked(): Promise<never> {
  throw new AuthorizationFlowDisabledError("plugin", "github");
}

describe("Thread input", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("runs a person's Turn in a Thread after its Agent invocation", async () => {
    const harness = await createHarness();
    try {
      await persistThreadStateById(slackParentConversationId, {
        conversation: {
          ...coerceThreadConversationState({}),
          messages: [
            {
              author: { userName: "dana" },
              createdAtMs: 1_000,
              id: "root-message-1",
              role: "user",
              text: "Ship the migration before the backfill.",
            },
          ],
        },
      });
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);

      await expect(
        sendPersonMessage(harness, threadId, "person-1"),
      ).resolves.toMatchObject({ status: "accepted" });
      await harness.process(threadId);

      const [invocationRun, personRun] = harness.runs;
      expect(invocationRun).toMatchObject({
        actor: slackInvocationInput.actor,
        agentInvocationId: expect.any(String),
      });
      // The person's Turn uses the Thread's own Destination and Location,
      // copies of its root's. Tool wiring reads its agent tools from
      // `turnBehavior`.
      expect(personRun).toMatchObject({
        actor: webTestActor,
        destination: slackDestination,
        // Not a Slack run: only a root delivers to its Location.
        surface: "api",
      });
      // A Thread is its own agent: its context is its own history, never the
      // root's Messages.
      const prompt = buildPromptInput({
        instruction: personRun!.instruction,
      });
      expect(JSON.stringify([personRun!.instruction, prompt])).not.toContain(
        "Ship the migration before the backfill.",
      );
      expect(personRun?.agentInvocationId).toBeUndefined();
      expect(personRun?.location).toEqual(invocationRun?.location);

      const thread = await harness.conversationStore.get({
        conversationId: threadId,
      });
      expect(thread).toMatchObject({
        destination: slackDestination,
        kind: "thread",
      });
      // A person's Turn sends nothing to the parent, and a completed Agent
      // invocation without a `reply` sends nothing either.
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state: harness.state,
      });
      expect(parentWork?.messages ?? []).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each(["direct", "unknown"] as const)(
    "runs a person's Turn in a Thread as private when the Slack root is %s",
    async (visibility) => {
      const harness = await createHarness();
      try {
        const threadId = await startThread(harness, "thread-spawn");
        await harness.process(threadId);
        await finishInvocation(harness, threadId);
        // A Slack DM, or a channel whose type is unknown, has no confirmed
        // visibility. Missing visibility is private.
        await getDb()
          .update(juniorDestinations)
          .set({ visibility })
          .where(eq(juniorDestinations.provider, "slack"));

        await expect(
          sendPersonMessage(harness, threadId, "person-1"),
        ).resolves.toMatchObject({ status: "accepted" });
        await harness.process(threadId);

        expect(harness.runs.at(-1)).toMatchObject({
          actor: webTestActor,
          source: { kind: "web", visibility: "private" },
        });
      } finally {
        await harness.close();
      }
    },
  );

  it("runs a person's Turn in a Thread under a private web root", async () => {
    const harness = await createHarness();
    try {
      const viewer = await resolveViewerUser(webTestActor.email);
      if (!viewer) throw new Error("Expected a web test viewer");
      const root = await createAndEnqueueConversation(
        {
          actor: webActorFromUser(viewer),
          idempotencyKey: "web-root",
          message: "Start the work.",
          visibility: "private",
        },
        {
          conversationStore: harness.conversationStore,
          queue: harness.queue,
          state: harness.state,
        },
      );
      const rootDestination = {
        platform: "local",
        conversationId: root.conversationId,
      } as const;
      const threadId = await startThread(harness, "thread-spawn", {
        destination: rootDestination,
        parentConversationId: root.conversationId,
      });
      await harness.process(threadId);
      await finishInvocation(harness, threadId);

      await sendPersonMessage(harness, threadId, "person-1");
      await harness.process(threadId);

      // The Turn replies in the Thread with the Destination and visibility
      // of its root.
      expect(harness.runs.at(-1)).toMatchObject({
        actor: webTestActor,
        conversationId: threadId,
        destination: rootDestination,
        source: {
          conversationId: threadId,
          kind: "web",
          visibility: "private",
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("resumes a person's Turn in a Thread after sign-in", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      const personTurnId = await savePersonTurn(threadId);

      await signInAndWake(harness, threadId, personTurnId);
      const runCount = harness.runs.length;
      await harness.processUntilRun(threadId);

      expect(harness.runs[runCount]).toMatchObject({
        actor: { platform: "web" },
        destination: slackDestination,
        turnId: personTurnId,
      });
      expect(harness.runs[runCount]?.agentInvocationId).toBeUndefined();
      // The wake leaves the Thread's work without a Destination. The
      // invocation worker refuses child work that has one.
      await expect(
        getConversationWorkState({
          conversationId: threadId,
          state: harness.state,
        }),
      ).resolves.not.toHaveProperty("destination");
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("runs a person's Message after the Agent invocation it waits behind", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      // The parent's next Agent invocation yielded between slices.
      const invocationId = await saveInvocationSlice(
        threadId,
        "paused",
        createWebSource(slackParentConversationId, "private"),
      );
      await yieldThreadWork(harness, threadId);
      await sendPersonMessage(harness, threadId, "person-1");
      harness.onInvocationRun(endBlocked);
      const runCount = harness.runs.length;
      await harness.process(threadId);

      // The Agent invocation resumes and ends first. Then the person's
      // Message starts its own Turn.
      expect(harness.runs.slice(runCount)).toMatchObject([
        { agentInvocationId: invocationId },
        { actor: webTestActor },
      ]);
      await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
        status: "blocked",
      });
      expect(harness.otherOpenTurns).toEqual([]);
      // Its own run ended the invocation's Turn. Its web Source does not make
      // it a person's Turn that the resume supersedes.
      await expect(
        getTurnRecord(threadId, getAgentInvocationTurnId(invocationId)),
      ).resolves.toMatchObject({
        errorMessage: expect.stringContaining(
          "cannot start an authorization flow",
        ),
      });
    } finally {
      await harness.close();
    }
  });

  it("runs the parent's input after the person's Turn it waits behind", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      // The person's Turn yielded between slices.
      const personTurnId = await savePersonTurn(threadId, "yield");
      await yieldThreadWork(harness, threadId);
      await sendParentMessage(harness, "call-message");
      const runCount = harness.runs.length;
      await harness.drain(threadId);

      // The person's Turn resumes first. Then the parent's input starts its
      // own Agent invocation.
      const later = harness.runs.slice(runCount);
      expect(later[0]).toMatchObject({
        actor: { platform: "web" },
        turnId: personTurnId,
      });
      expect(later.at(-1)?.agentInvocationId).toEqual(expect.any(String));
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("ends a person's sign-in pause when the parent's input arrives", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      const personTurnId = await savePersonTurn(threadId);

      await sendParentMessage(harness, "call-message");
      await harness.process(threadId);

      // As on a root, new input supersedes a Turn that waits for sign-in,
      // and runs in a Turn of its own.
      expect(harness.runs.at(-1)?.agentInvocationId).toEqual(
        expect.any(String),
      );
      await expect(
        getTurnRecord(threadId, personTurnId),
      ).resolves.toMatchObject({ state: "abandoned" });
      await expect(
        getAuthPausedConversationTurnId(threadId),
      ).resolves.toBeUndefined();
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    // Its worker died after it took its input. The Message comes before the
    // heartbeat.
    ["running", "Agent invocation lost its worker before it could pause"],
    // It paused between slices, and no wake for its next slice is left.
    [
      "paused",
      "A person sent a Message in this Thread, so this task ended without a result. Send messageAgent again if you still need this work.",
    ],
  ] as const)(
    "ends a %s Agent invocation when a person's Message arrives",
    async (mode, errorMessage) => {
      const harness = await createHarness();
      try {
        const threadId = await startThread(harness, "thread-spawn");
        await harness.process(threadId);
        await finishInvocation(harness, threadId);
        const invocationId = await saveInvocationSlice(threadId, mode);
        if (mode === "running") await leaveExpiredLease(harness, threadId);
        await sendPersonMessage(harness, threadId, "person-1");
        const runCount = harness.runs.length;
        await harness.processUntilRun(threadId);

        expect(harness.runs[runCount]).toMatchObject({ actor: webTestActor });
        await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
          status: "failed",
        });
        await expect(readParentResults(harness, invocationId)).resolves.toEqual(
          ["agent_invocation.failed"],
        );
        const parentWork = await getConversationWorkState({
          conversationId: slackParentConversationId,
          state: harness.state,
        });
        expect(parentWork?.messages.at(-1)?.input.text).toContain(errorMessage);
        expect(harness.otherOpenTurns).toEqual([]);
      } finally {
        await harness.close();
      }
    },
  );

  it("recovers a lost Agent invocation in a Thread", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      const invocationId = await saveInvocationSlice(threadId, "running");
      await expireLostWorker(harness, threadId);
      await harness.drain(threadId);

      // The recovery wake ends the lost Agent invocation, and the parent gets
      // its result.
      await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
        errorMessage: "Agent invocation lost its worker before it could pause",
        status: "failed",
      });
      await expect(readParentResults(harness, invocationId)).resolves.toEqual([
        "agent_invocation.failed",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("recovers a person's Turn in a Thread that lost its worker", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startThread(harness, "thread-spawn");
      await harness.process(threadId);
      await finishInvocation(harness, threadId);
      const personTurnId = await savePersonTurn(threadId, "running");
      await expireLostWorker(harness, threadId);
      const runCount = harness.runs.length;
      await harness.processUntilRun(threadId);

      // As on a root, the recovery wake resumes the open Turn.
      expect(harness.runs[runCount]).toMatchObject({
        actor: { platform: "web" },
        turnId: personTurnId,
      });
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
