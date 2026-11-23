import { randomUUID } from "node:crypto";
import { createSlackSource, createWebSource } from "@sentry/junior-plugin-api";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { assertRunConsistency, type AgentRun } from "@/chat/agent/types";
import {
  completedAgentRun,
  type AgentRunOutcome,
} from "@/chat/runtime/agent-run-outcome";
import { buildTurnResult } from "@/chat/services/turn-result";
import type { TurnAnswer } from "@/chat/turn-answer";
import { appendAndEnqueueWebMessage } from "@/chat/conversations/web-input";
import { openConversationProjection } from "@/chat/conversations/projection";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "./agent-invocations";
import { webTestActor } from "./conversation";
import { createConversationWorkHarness } from "./conversation-work";
import { createWebAuthorization } from "@/chat/conversations/web-authorization";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";

/** Compose production Conversation work with a Slack root. */
export async function createHarness() {
  const { conversationStore, fixture } = await prepareSlackParentConversation();
  // The name keys the Thread's Conversation id. Work that an earlier test
  // left running can still write that Conversation, so each test has its own.
  const agentName = `researcher-${randomUUID().slice(0, 8)}`;
  // Integration tests do not run the agent. The runner checks each run as
  // the agent does first, reads it, and stops it, unless the test ends its
  // runs with `onRun`.
  const runs: AgentRun[] = [];
  // A Conversation has one open Turn. Any other open Turn seen when a run
  // starts lands here.
  const otherOpenTurns: string[] = [];
  let onRun: ((run: AgentRun) => Promise<AgentRunOutcome>) | undefined;
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
      if (onRun) {
        return await onRun(run);
      }
      throw new Error("stop after reading the run");
    },
  });
  /** Run the next queued wake of one Conversation. */
  const process = async (conversationId: string) =>
    await work.process(work.queue.takeMessageFor(conversationId));
  return {
    agentName,
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
    /**
     * Run `fn` in each later run. The run ends as `fn` returns or throws.
     * Undefined restores the default runner.
     */
    onRun: (fn: ((run: AgentRun) => Promise<AgentRunOutcome>) | undefined) => {
      onRun = fn;
    },
    otherOpenTurns,
    process,
    queue: work.queue,
    runs,
    state: work.state,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

// The checkpoint fields of a run's input: its history, then its instruction.
/** The first checkpoint of a run's Turn, as the agent saves it. */
export function runInputCheckpoint(run: AgentRun) {
  const history = run.history?.messages ?? [];
  return {
    actor: run.actor!,
    conversationId: run.conversationId,
    messages: [
      ...history,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: run.instruction.text }],
        timestamp: Date.now(),
      },
    ],
    sliceId: 1,
    source: run.source!,
    surface: run.surface,
    // As the agent does, the input keeps its author, such as a parent agent.
    ...(run.instruction.provenance
      ? { trailingMessageProvenance: [run.instruction.provenance] }
      : undefined),
    turnId: run.turnId,
  };
}

/**
 * Take a run's input as the agent does before its first model call: save it
 * as the Turn's first checkpoint, then commit it. The Turn then has a stored
 * record, as a real run's Turn does.
 */
export async function commitRunInput(run: AgentRun): Promise<void> {
  await saveTurnCheckpoint({ ...runInputCheckpoint(run), mode: "running" });
  await run.durability?.onInputCommitted?.();
}

/** Pause a run's Turn at a yield, as the agent does between slices. */
export async function yieldRun(run: AgentRun): Promise<AgentRunOutcome> {
  const record = await saveTurnCheckpoint({
    ...runInputCheckpoint(run),
    mode: "paused",
    reason: "yield",
  });
  if (!record) {
    throw new Error(`Turn ${run.turnId} saved no yield checkpoint`);
  }
  return {
    reason: "yield",
    resumeVersion: record.version,
    status: "suspended",
  };
}

/**
 * End a run's Turn with `answer`, as the agent does when it calls `reply` or
 * `noReply`, and save the Turn's completed record. A `finalText` answer ends
 * a Turn that is not gated with that final response.
 */
export async function finishRun(
  run: AgentRun,
  answer: TurnAnswer | { finalText: string } = { noReply: {} },
): Promise<AgentRunOutcome> {
  const input = runInputCheckpoint(run);
  await saveTurnCheckpoint({ ...input, mode: "running" });
  await run.durability?.onInputCommitted?.();
  await saveTurnCheckpoint({ ...input, mode: "completed" });
  const ending =
    "finalText" in answer
      ? {
          newMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: answer.finalText }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
          ],
        }
      : { answer, newMessages: [] };
  return completedAgentRun(
    buildTurnResult({
      ...ending,
      generatedFileCount: 0,
      modelId: "test-model",
      reasoningLevel: "medium",
      shouldTrace: false,
      toolCalls: [],
      userInput: run.instruction.text,
    }),
  );
}

/** Start a named child agent, a Thread unless `kind` says otherwise. */
export async function startThread(
  harness: Harness,
  idempotencyKey: string,
  input: { kind?: "task" | "thread"; parentConversationId?: string } = {},
) {
  const created = await spawnChildAgent(
    {
      ...slackInvocationInput,
      kind: "thread",
      ...input,
      agentName: harness.agentName,
      // The key names the child's Conversation, so each harness has its own.
      idempotencyKey: `${idempotencyKey}:${harness.agentName}`,
      parentToolCallId: idempotencyKey,
      parentTurnId: idempotencyKey,
    },
    {
      conversationStore: harness.conversationStore,
      queue: harness.queue,
      state: harness.state,
    },
  );
  return created.childConversationId;
}

/** Start a Thread and end its parent task's Turn without a `reply`. */
export async function startFinishedThread(
  harness: Harness,
  idempotencyKey = "thread-spawn",
): Promise<string> {
  const threadId = await startThread(harness, idempotencyKey);
  harness.onRun(finishRun);
  await harness.drain(threadId);
  harness.onRun(undefined);
  return threadId;
}

/** The Run of the shared Slack parent Turn that spawns and messages children. */
export function slackParentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
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
    ...overrides,
  };
}

export async function spawnThread(harness: Harness, toolCallId: string) {
  const { childConversationId } = await bindSpawnAgent(slackParentRun(), {
    conversationStore: harness.conversationStore,
    queue: harness.queue,
    state: harness.state,
  })!(
    { kind: "thread", name: harness.agentName, task: "Check the deploy." },
    { toolCallId },
  );
  return childConversationId;
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
  // The Turn's prompt follows the Thread's committed history, such as its
  // parent's task.
  const history = (
    await openConversationProjection({ conversationId: threadId })
  ).messages;
  const turn = {
    conversationId: threadId,
    turnId,
    sliceId: 1,
    messages: [...history, ...personPausedPrompt],
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
