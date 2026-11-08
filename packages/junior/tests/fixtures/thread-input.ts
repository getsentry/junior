import { createWebSource } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
} from "@/chat/agent-invocations/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { assertRunConsistency, type AgentRun } from "@/chat/agent/types";
import type { CreateAgentInvocationInput } from "@/chat/agent-invocations/types";
import { appendAndEnqueueWebMessage } from "@/chat/conversations/web-input";
import { getDb } from "@/chat/db";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { juniorConversations } from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
} from "./agent-invocations";
import { webTestActor } from "./conversation";
import { createConversationWorkHarness } from "./conversation-work";
import { createWebAuthorization } from "@/chat/conversations/web-authorization";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { expect } from "vitest";

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
      assertRunConsistency(
        run,
        (await conversationStore.get({ conversationId: run.conversationId }))
          ?.kind,
      );
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

/** Save the Message that a person's Turn in a Thread stores first. */
async function savePersonMessage(
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
  mode: "auth" | "running" | "yield" = "auth",
  options: { signInPrompt?: boolean; withoutMessage?: boolean } = {},
) {
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
