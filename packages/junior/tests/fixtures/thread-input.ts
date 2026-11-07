/**
 * Thread input scenarios: a Slack root with production Conversation work, and
 * helpers that start, message, pause, sign in, and stop its Threads.
 */
import {
  createSlackSource,
  createWebSource,
  type Source,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { createAgentInvocationForMessage } from "@/chat/agent-invocations/create";
import { getAgentInvocationTurnId } from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { checkRunConsistency } from "@/chat/agent/run-consistency";
import type { AgentRun } from "@/chat/agent/types";
import type { CreateAgentInvocationInput } from "@/chat/agent-invocations/types";
import { appendAndEnqueueWebMessage } from "@/chat/conversations/web-input";
import { openConversationProjection } from "@/chat/conversations/projection";
import { createWebAuthorization } from "@/chat/conversations/web-authorization";
import { getDb } from "@/chat/db";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  coerceThreadConversationState,
  type ConversationPendingAuthState,
} from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  getTurnRecord,
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  getConversationWorkState,
  releaseConversationWork,
  requestAnotherSlice,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import { recordTurnAuthorization } from "@/chat/task-execution/authorized-turn";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { createMessageAgentTool } from "@/chat/tools/runtime/message-agent";
import { bindStopAgent } from "@/chat/agent-invocations/stop";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import { juniorConversations } from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "./agent-invocations";
import { webTestActor } from "./conversation";
import { createConversationWorkHarness } from "./conversation-work";

/** Compose production Conversation work with a Slack root. */
export async function createHarness() {
  const { conversationStore, fixture } = await prepareSlackParentConversation();
  // Integration tests do not run the agent. The runner checks each run as
  // the agent does first, reads it, and stops it. The test finishes each
  // Agent invocation itself, or ends its runs with `onInvocationRun`.
  const runs: AgentRun[] = [];
  // A Conversation has one open Turn. Any other open Turn seen when a run
  // starts lands here.
  const otherOpenTurns: string[] = [];
  let onInvocationRun: (() => Promise<never>) | undefined;
  const work = await createConversationWorkHarness({
    run: async (run) => {
      await checkRunConsistency(run);
      runs.push(run);
      otherOpenTurns.push(
        ...(await listTurnSummaries(run.conversationId))
          .filter(
            (turn) =>
              turn.turnId !== run.turnId &&
              (turn.state === "paused" || turn.state === "running"),
          )
          .map((turn) => turn.turnId),
      );
      if (run.agentInvocationId && onInvocationRun) {
        await onInvocationRun();
      }
      throw new Error("stop after reading the run");
    },
  });
  /** Run the next queued wake of one Conversation. */
  const process = async (conversationId: string) =>
    await work.process(work.queue.takeMessageFor(conversationId));
  return {
    close: async () => await fixture.close(),
    conversationStore,
    /** Run every queued wake of one Conversation, as the queue does. */
    drain: async (conversationId: string) => {
      while (
        work.queue
          .queuedMessages()
          .some((message) => message.conversationId === conversationId)
      ) {
        await process(conversationId);
      }
    },
    /**
     * Run the queued wakes of one Conversation until the agent runs. A run
     * that the runner stops retries, so this stops at the first run.
     */
    processUntilRun: async (conversationId: string) => {
      const runCount = runs.length;
      while (
        runs.length === runCount &&
        work.queue
          .queuedMessages()
          .some((message) => message.conversationId === conversationId)
      ) {
        await process(conversationId);
      }
    },
    /** Run `fn` in each later Agent invocation run. It ends the run. */
    onInvocationRun: (fn: () => Promise<never>) => {
      onInvocationRun = fn;
    },
    otherOpenTurns,
    process,
    queue: work.queue,
    runs,
    state: work.state,
  };
}

/** Harness returned by `createHarness`. */
export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Finish the open Agent invocation of a child, then report its result. */
export async function finishInvocation(
  harness: Harness,
  childConversationId: string,
) {
  const invocation =
    await getActiveAgentInvocationForConversation(childConversationId);
  if (!invocation) throw new Error("Expected an open Agent invocation");
  await completeAgentInvocation({
    invocationId: invocation.invocationId,
    result: "Found it.",
    status: "completed",
  });
  await expect(harness.process(childConversationId)).resolves.toMatchObject({
    status: "completed",
  });
}

/**
 * Start a named child agent and store it as a Thread. Spawn creates only
 * Tasks until Threads have their own entry point.
 */
export async function startThread(
  harness: Harness,
  idempotencyKey: string,
  input: Partial<
    Pick<CreateAgentInvocationInput, "destination" | "parentConversationId">
  > = {},
) {
  const created = await createAndEnqueueAgentInvocation(
    {
      ...slackInvocationInput,
      ...input,
      agentName: "researcher",
      idempotencyKey,
    },
    {
      conversationStore: harness.conversationStore,
      queue: harness.queue,
      state: harness.state,
    },
  );
  await getDb()
    .update(juniorConversations)
    .set({ kind: "thread" })
    .where(eq(juniorConversations.conversationId, created.childConversationId));
  return created.childConversationId;
}

export async function sendPersonMessage(
  harness: Harness,
  conversationId: string,
  idempotencyKey: string,
) {
  return await appendAndEnqueueWebMessage(
    {
      actor: webTestActor,
      conversationId,
      idempotencyKey,
      message: "What did you find?",
    },
    {
      conversationStore: harness.conversationStore,
      queue: harness.queue,
      state: harness.state,
    },
  );
}

/** Give the Thread more work from its parent agent, like messageAgent. */
export async function sendParentMessage(harness: Harness, toolCallId: string) {
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

/** Save the Message that a person's Turn in a Thread stores first. */
export async function savePersonMessage(
  threadId: string,
  messageId: string | undefined,
  createdAtMs: number,
  pendingAuth?: ConversationPendingAuthState,
) {
  const conversation = coerceThreadConversationState({});
  await persistThreadStateById(threadId, {
    conversation: {
      ...conversation,
      processing: { ...conversation.processing, pendingAuth },
      messages: messageId
        ? [
            {
              author: { userName: webTestActor.userName },
              createdAtMs,
              id: messageId,
              meta: { explicitMention: true, source: "web" },
              role: "user",
              text: "What did you find?",
            },
          ]
        : [],
    },
  });
}

/** The prompt that a person's sign-in-paused Turn holds. */
export const personPausedPrompt = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "What did you find?" }],
    timestamp: 1,
  },
];

/**
 * Save the person's Message and their Turn: `auth` when it waits for a
 * sign-in callback, `yield` between slices, `running` when its worker died
 * mid-Turn. With `signInPrompt`, also save the pending sign-in and the
 * dashboard prompt that a sign-in pause shows. With `withoutMessage`, leave
 * the Turn stranded without its Message.
 */
export async function savePersonTurn(
  threadId: string,
  options: {
    mode?: "auth" | "running" | "yield";
    signInPrompt?: boolean;
    withoutMessage?: boolean;
  } = {},
) {
  const mode = options.mode ?? "auth";
  const messageId = "api-msg_person-paused";
  const turnId = buildDeterministicTurnId(messageId);
  await savePersonMessage(
    threadId,
    options.withoutMessage ? undefined : messageId,
    1,
    options.signInPrompt
      ? {
          actorId: webTestActor.userId,
          kind: "plugin",
          linkSentAtMs: 1,
          provider: "github",
          sessionId: turnId,
        }
      : undefined,
  );
  if (options.signInPrompt) {
    await createWebAuthorization({
      actorId: webTestActor.userId,
      conversationId: threadId,
    }).deliver({
      authorizationUrl: "https://github.example/authorize",
      completionText: "Signed in to GitHub.",
      label: "GitHub",
    });
  }
  const turn = {
    conversationId: threadId,
    turnId,
    sliceId: 1,
    messages: personPausedPrompt,
    destination: slackDestination,
    source: createWebSource(threadId, "public"),
    actor: webTestActor,
    surface: "api" as const,
  };
  await saveTurnCheckpoint(
    mode === "running"
      ? { ...turn, mode }
      : { ...turn, mode: "paused", reason: mode },
  );
  return turnId;
}

/**
 * Save the slice that a parent's Agent invocation leaves after it took its
 * input: `running` when its worker died, `paused` when it yielded. An
 * invocation that a web Turn started keeps that Turn's web Source.
 */
export async function saveInvocationSlice(
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

/**
 * Record the person's sign-in, as the OAuth callback does, and send its one
 * empty wake.
 */
export async function signInAndWake(
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
export async function yieldThreadWork(harness: Harness, threadId: string) {
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
export async function leaveExpiredLease(harness: Harness, threadId: string) {
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
export async function expireLostWorker(harness: Harness, threadId: string) {
  await leaveExpiredLease(harness, threadId);
  await recoverConversationWork({
    nowMs: Date.now(),
    queue: harness.queue,
    state: harness.state,
  });
}

/** Read the event types that the parent got for one Agent invocation. */
export async function readParentResults(
  harness: Harness,
  invocationId: string,
) {
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
export async function endBlocked(): Promise<never> {
  throw new AuthorizationFlowDisabledError("plugin", "github");
}

/** Stop the Thread from its parent with the stopAgent tool. */
export async function stopThread(harness: Harness, threadId: string) {
  await expect(
    createStopAgentTool(
      bindStopAgent(
        { conversationId: slackParentConversationId },
        { queue: harness.queue },
      ),
    ).execute!({ conversation_id: threadId }, {}),
  ).resolves.toMatchObject({ stopped: true });
}
