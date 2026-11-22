import { createSlackSource } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { buildPromptInput } from "@/chat/agent/prompt";
import { type AgentRun } from "@/chat/agent/types";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
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
  finishRun,
  sendPersonMessage,
  savePersonTurn,
  spawnThread,
  startFinishedThread,
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
    { text: "Also check the retry path.", to: harness.agentName },
    {
      toolCallId,
    },
  );
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

/** End a run as blocked on a sign-in it cannot ask for. */
async function endBlocked(): Promise<never> {
  throw new AuthorizationFlowDisabledError("plugin", "github");
}

describe("Thread input", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("runs a person's Turn in a Thread after its parent's task", async () => {
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
      const threadId = await startFinishedThread(harness);

      await expect(
        sendPersonMessage(harness, threadId, "person-1"),
      ).resolves.toMatchObject({ status: "accepted" });
      await harness.process(threadId);

      const [parentRun, personRun] = harness.runs;
      expect(parentRun).toMatchObject({
        actor: slackInvocationInput.actor,
        source: { kind: "parent_message" },
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
      expect(personRun?.source.kind).toBe("web");
      expect(personRun?.location).toEqual(parentRun?.location);

      const thread = await harness.conversationStore.get({
        conversationId: threadId,
      });
      expect(thread).toMatchObject({
        destination: slackDestination,
        kind: "thread",
      });
      // A person's Turn sends nothing to the parent, and a parent task's
      // Turn without a `reply` sends nothing either.
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
        const threadId = await startFinishedThread(harness);
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
        parentConversationId: root.conversationId,
      });
      harness.onRun(finishRun);
      await harness.drain(threadId);

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
      const threadId = await startFinishedThread(harness);
      const personTurnId = await savePersonTurn(threadId);

      await signInAndWake(harness, threadId, personTurnId);
      const runCount = harness.runs.length;
      await harness.processUntilRun(threadId);

      expect(harness.runs[runCount]).toMatchObject({
        actor: { platform: "web" },
        destination: slackDestination,
        turnId: personTurnId,
      });
      // The wake leaves the Thread's work without a Destination.
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

  it("runs the parent's input after the person's Turn it waits behind", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startFinishedThread(harness);
      // The person's Turn yielded between slices.
      const personTurnId = await savePersonTurn(threadId, "yield");
      await yieldThreadWork(harness, threadId);
      await sendParentMessage(harness, "call-message");
      const runCount = harness.runs.length;
      await harness.drain(threadId);

      // The person's Turn resumes first. Then the parent's input starts its
      // own Turn.
      const later = harness.runs.slice(runCount);
      expect(later[0]).toMatchObject({
        actor: { platform: "web" },
        turnId: personTurnId,
      });
      expect(later.at(-1)?.source.kind).toBe("parent_message");
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("runs the parent's input apart from a person's in a Thread", async () => {
    const harness = await createHarness();
    try {
      const threadId = await spawnThread(harness, "call-spawn");
      await sendParentMessage(harness, "call-message");
      await sendPersonMessage(harness, threadId, "person-1");
      // Each Turn ends blocked on a sign-in that it cannot ask for.
      harness.onRun(endBlocked);
      await harness.drain(threadId);

      // The parent's task and message share one Turn, as the Actor of the
      // parent's Turn. The person's Message runs in a Turn of its own.
      const turnIds = (platform: string) => [
        ...new Set(
          harness.runs
            .filter((run) => run.actor?.platform === platform)
            .map((run) => run.turnId),
        ),
      ];
      expect(turnIds("slack")).toHaveLength(1);
      expect(turnIds("web")).toHaveLength(1);
      const parentRun = harness.runs.find(
        (run) => run.actor?.platform === "slack",
      )!;
      expect(parentRun).toMatchObject({ actor: slackInvocationInput.actor });
      expect(parentRun.instruction.text).toContain("Check the deploy.");
      expect(parentRun.instruction.text).toContain(
        "Also check the retry path.",
      );
      expect(
        harness.runs.find((run) => run.actor?.platform === "web")!.instruction
          .text,
      ).not.toContain("Check the deploy.");
      expect(harness.otherOpenTurns).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("ends a person's sign-in pause when the parent's input arrives", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startFinishedThread(harness);
      const personTurnId = await savePersonTurn(threadId);

      await sendParentMessage(harness, "call-message");
      await harness.process(threadId);

      // As on a root, new input supersedes a Turn that waits for sign-in,
      // and runs in a Turn of its own.
      expect(harness.runs.at(-1)?.source.kind).toBe("parent_message");
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

  it("recovers a person's Turn in a Thread that lost its worker", async () => {
    const harness = await createHarness();
    try {
      const threadId = await startFinishedThread(harness);
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
