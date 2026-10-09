/**
 * Plugin dispatch mailbox adapter.
 *
 * Dispatch metadata selects exact authority and maintains the plugin-facing
 * projection. The shared conversation worker and turn runtime own execution,
 * leases, retries, continuation, delivery, and recovery.
 */
import type { StateAdapter } from "chat";
import { z } from "zod";
import type { ConversationStore } from "@/chat/conversations/store";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationStore } from "@/chat/db";
import {
  getConversationTurnBoundaryError,
  isCooperativeTurnYieldError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import {
  getTurnRecord,
  listTurnSummaries,
  recordTurnSummary,
} from "@/chat/task-execution/checkpoint";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import {
  appendAndEnqueueInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  claimDispatchMailboxAppend,
  confirmDispatchMailboxAppend,
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchRecord,
  getDispatchTurnId,
  isTerminalDispatchStatus,
  markDispatchAwaitingResume,
  markDispatchBlocked,
  markDispatchCoalesced,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchRunning,
} from "./store";
import type {
  DispatchRecord,
  DispatchTurnContext,
  DispatchTurnResult,
} from "./types";

const agentDispatchMailboxMetadataSchema = z
  .object({
    dispatchId: z.string().min(1),
    kind: z.literal("agent_dispatch"),
  })
  .strict();

export const AGENT_DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface DurableDispatchTurnResult extends DispatchTurnResult {
  hasResumableRun?: boolean;
}

type DispatchRoutingContext = Pick<
  DispatchTurnContext,
  "credentialContext" | "dispatch" | "surface"
> & { actor: DispatchRecord["actor"] };

/** Restore the exact actor, credential, and dispatch routing for every slice. */
export function buildDispatchRoutingContext(
  dispatch: DispatchRecord,
): DispatchRoutingContext {
  return {
    actor: dispatch.actor,
    credentialContext: credentialContextForActor(
      dispatch.actor,
      dispatch.credentialSubject,
    ),
    dispatch: {
      actor: dispatch.actor,
      id: dispatch.id,
      metadata: dispatch.metadata,
      plugin: dispatch.plugin,
      replyAttribution: dispatch.replyAttribution,
      outcomes: dispatch.outcomes,
    },
    surface: "api",
  };
}

interface EnqueueAgentDispatchOptions {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  /** Delay the Conversation wake so related dispatches join one Turn. */
  queueDelayMs?: number;
  state?: StateAdapter;
}

/** Dependencies for dispatch work owned by the conversation worker. */
export interface AgentDispatchConversationWorkerOptions {
  resumeTurn: (
    dispatch: DispatchRecord,
    hooks: { shouldYield?: () => boolean },
  ) => Promise<void>;
  runTurn: (
    dispatch: DispatchRecord,
    hooks: {
      ack: () => Promise<void>;
      shouldYield?: () => boolean;
    },
  ) => Promise<DispatchTurnResult>;
}

/** Build the stable mailbox work item for one agent dispatch. */
export function buildAgentDispatchInboundMessage(
  dispatch: DispatchRecord,
  nowMs = Date.now(),
): InboundMessage {
  return {
    conversationId: getDispatchConversationId(dispatch),
    createdAtMs: dispatch.createdAtMs,
    delivery: "defer",
    destination: dispatch.destination,
    inboundMessageId: getDispatchInputMessageId(dispatch.id),
    input: {
      // The dispatch record is the idempotent request authority. The mailbox
      // only signals which request this conversation lease may advance.
      text: "[plugin dispatch]",
      metadata: {
        dispatchId: dispatch.id,
        kind: "agent_dispatch",
      },
    },
    receivedAtMs: nowMs,
    source: "plugin",
  };
}

/** Persist dispatch mailbox work before sending its conversation wake-up. */
export async function enqueueAgentDispatch(
  dispatch: DispatchRecord,
  options: EnqueueAgentDispatchOptions,
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const claimedDispatch = await claimDispatchMailboxAppend(dispatch.id);
  if (!claimedDispatch) {
    return;
  }
  await (options.conversationStore ?? getConversationStore()).recordActivity({
    activityAtMs: claimedDispatch.createdAtMs,
    conversationId: getDispatchConversationId(claimedDispatch),
    destination: claimedDispatch.destination,
    nowMs,
    source: "plugin",
    sessionSource: claimedDispatch.source,
    visibility: claimedDispatch.destinationVisibility,
  });
  await appendAndEnqueueInboundMessage({
    message: buildAgentDispatchInboundMessage(claimedDispatch, nowMs),
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    ...(options.queueDelayMs !== undefined
      ? { queueDelayMs: options.queueDelayMs }
      : undefined),
    state: options.state,
  });
  await confirmDispatchMailboxAppend(claimedDispatch.id);
}

/** Parse dispatch ids, in mailbox order, from durable mailbox messages. */
function dispatchIdsFromMessages(
  messages: readonly InboundMessage[],
): string[] | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  const parsed = messages.map((message) =>
    agentDispatchMailboxMetadataSchema.safeParse(message.input.metadata),
  );
  if (parsed.every((result) => !result.success)) {
    return undefined;
  }
  if (parsed.some((result) => !result.success)) {
    throw new Error("Conversation mailbox mixes dispatch and provider input");
  }
  return [
    ...new Set(
      parsed.map((result) => {
        if (!result.success) {
          throw new Error("Dispatch mailbox metadata failed validation");
        }
        return result.data.dispatchId;
      }),
    ),
  ];
}

/**
 * Resolve dispatches from concrete mailbox metadata or the active turn.
 *
 * A shared Conversation can hold several pending dispatches. They run in one
 * Turn. Provider source and conversation-id conventions are deliberately not
 * execution routing authority.
 */
export async function resolveAgentDispatchIds(
  context: ConversationWorkerContext,
): Promise<string[] | undefined> {
  const mailboxDispatchIds = dispatchIdsFromMessages(context.attempt.messages);
  if (mailboxDispatchIds) {
    return mailboxDispatchIds;
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }

  const summaries = await listTurnSummaries(context.conversationId);
  const activeDispatchIds = new Set(
    summaries
      .filter(
        (summary) =>
          (summary.state === "paused" || summary.state === "running") &&
          Boolean(summary.dispatchId),
      )
      .map((summary) => summary.dispatchId)
      .filter((id): id is string => Boolean(id)),
  );
  if (activeDispatchIds.size > 1) {
    throw new Error(
      `Conversation ${context.conversationId} has multiple active dispatches`,
    );
  }
  const activeDispatchId = activeDispatchIds.values().next().value;
  if (activeDispatchId) {
    return [activeDispatchId];
  }
  const durableDispatchIds = new Set(
    summaries
      .map((summary) => summary.dispatchId)
      .filter((id): id is string => Boolean(id)),
  );
  const unfinishedDispatchIds: string[] = [];
  for (const id of durableDispatchIds) {
    const dispatch = await getDispatchRecord(id);
    if (dispatch && !isTerminalDispatchStatus(dispatch.status)) {
      unfinishedDispatchIds.push(id);
    }
  }
  if (unfinishedDispatchIds.length > 1) {
    throw new Error(
      `Conversation ${context.conversationId} has multiple unfinished dispatch sessions`,
    );
  }
  return unfinishedDispatchIds.length > 0 ? unfinishedDispatchIds : undefined;
}

async function readDispatchTurnResult(
  dispatch: DispatchRecord,
): Promise<DurableDispatchTurnResult> {
  const conversationId = getDispatchConversationId(dispatch);
  const turnId = getDispatchTurnId(dispatch.id);
  const storedSession = await getTurnRecord(conversationId, turnId);
  const summary = (await listTurnSummaries(conversationId)).find(
    (candidate) => candidate.turnId === turnId,
  );
  const session = storedSession ?? summary;
  const dispatchOutcome =
    summary?.dispatchOutcome ?? storedSession?.dispatchOutcome;
  const resultMessageTs =
    summary?.resultMessageId ?? storedSession?.resultMessageId;
  const errorMessage = storedSession?.errorMessage;
  if (dispatchOutcome) {
    return {
      ...(errorMessage ? { errorMessage } : undefined),
      outcome: dispatchOutcome,
      ...(resultMessageTs ? { resultMessageTs } : undefined),
    };
  }
  if (resultMessageTs) {
    // Provider acceptance is the delivery fence. A worker may die before the
    // terminal outcome write, but redelivery must never regenerate that reply.
    return {
      outcome: "completed",
      resultMessageTs,
    };
  }
  if (!session) {
    return {};
  }
  if (session.state === "paused") {
    return { hasResumableRun: true, outcome: "awaiting_resume" };
  }
  if (session.state === "running") {
    return { hasResumableRun: true };
  }
  if (session.state !== "completed") {
    return {};
  }
  return {
    outcome: "completed",
    ...(resultMessageTs ? { resultMessageTs } : undefined),
  };
}

async function projectDispatchTurnResult(
  dispatchId: string,
  result: DispatchTurnResult,
): Promise<void> {
  switch (result.outcome) {
    case "awaiting_resume":
      await markDispatchAwaitingResume(dispatchId);
      break;
    case "blocked":
      await markDispatchBlocked(
        dispatchId,
        "Dispatch requires authorization that is unavailable for background work",
        result.resultMessageTs,
      );
      break;
    case "failed":
      await markDispatchFailed(
        dispatchId,
        result.errorMessage ?? "Agent turn failed",
        result.resultMessageTs,
      );
      break;
    case "completed":
      await markDispatchCompleted(dispatchId, result.resultMessageTs);
      break;
  }
}

function getDispatchBlockingError(
  error: unknown,
): AuthorizationFlowDisabledError | PluginCredentialFailureError | undefined {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return cause instanceof AuthorizationFlowDisabledError ||
    cause instanceof PluginCredentialFailureError
    ? cause
    : undefined;
}

async function persistBlockedDispatchTurn(
  dispatch: DispatchRecord,
  error: AuthorizationFlowDisabledError | PluginCredentialFailureError,
): Promise<void> {
  const conversationId = getDispatchConversationId(dispatch);
  const sessionId = getDispatchTurnId(dispatch.id);
  const session = await getTurnRecord(conversationId, sessionId);
  await recordTurnSummary({
    actor: dispatch.actor,
    conversationId,
    destination: dispatch.destination,
    destinationVisibility: dispatch.destinationVisibility,
    dispatchId: dispatch.id,
    dispatchOutcome: "blocked",
    turnId: sessionId,
    sliceId: session?.sliceId ?? 1,
    source: dispatch.source,
    state: "failed",
    surface: "api",
  });
  await markDispatchBlocked(
    dispatch.id,
    error instanceof AuthorizationFlowDisabledError
      ? `Dispatch requires ${error.provider} authorization.`
      : error.message,
  );
}

/**
 * Join the input of every dispatch in one Turn, oldest first.
 *
 * The newest dispatch owns the Turn. Earlier dispatches only add their input.
 */
function joinDispatchInput(
  dispatch: DispatchRecord,
  joined: readonly DispatchRecord[],
): DispatchRecord {
  if (joined.length === 0) {
    return dispatch;
  }
  return {
    ...dispatch,
    input: [...joined, dispatch].map((record) => record.input).join("\n\n"),
  };
}

/**
 * Split joined dispatches by whether the owner's existing Turn holds their
 * input. Dispatches that reached the mailbox after that Turn started wait.
 */
function splitJoinedByTurn(
  owner: DispatchRecord,
  joined: readonly DispatchRecord[],
): { held: DispatchRecord[]; waiting: DispatchRecord[] } {
  const heldIds = new Set(owner.joinedDispatchIds ?? []);
  return {
    held: joined.filter((record) => heldIds.has(record.id)),
    waiting: joined.filter((record) => !heldIds.has(record.id)),
  };
}

/** Run one dispatch start or resume under the owning conversation lease. */
export function createAgentDispatchConversationWorker(
  options: AgentDispatchConversationWorkerOptions,
): (
  context: ConversationWorkerContext,
  dispatchIds: readonly string[],
) => Promise<ConversationWorkerResult> {
  return async (context, dispatchIds) => {
    const dispatches: DispatchRecord[] = [];
    for (const dispatchId of dispatchIds) {
      const record = await getDispatchRecord(dispatchId);
      if (!record) {
        throw new Error(`Dispatch record is missing for ${dispatchId}`);
      }
      const expectedConversationId = getDispatchConversationId(record);
      if (context.conversationId !== expectedConversationId) {
        throw new Error(
          `Dispatch ${record.id} belongs to ${expectedConversationId}, not ${context.conversationId}`,
        );
      }
      if (
        !context.destination ||
        context.destination.platform !== record.destination.platform ||
        context.destination.teamId !== record.destination.teamId ||
        context.destination.channelId !== record.destination.channelId
      ) {
        throw new Error(
          `Dispatch ${record.id} destination does not match its conversation lease`,
        );
      }
      dispatches.push(record);
    }
    const unfinished = dispatches.filter(
      (record) => !isTerminalDispatchStatus(record.status),
    );
    // A started dispatch keeps its Turn after a redelivery. Otherwise the
    // newest dispatch owns the Turn.
    const dispatch =
      [...unfinished].reverse().find((record) => record.status !== "pending") ??
      unfinished.at(-1);
    const joined = unfinished.filter((record) => record !== dispatch);
    // Joined dispatches that complete when the mailbox is acknowledged. A new
    // Turn holds all of them. A resumed Turn holds only those it recorded.
    let coalesced = joined;

    let acknowledged = context.attempt.messages.length === 0;
    const acknowledge = async (): Promise<void> => {
      if (acknowledged) {
        return;
      }
      try {
        await context.attempt.ack();
      } catch {
        throw new TurnInputCommitLostError(
          `Conversation work lease lost before dispatch inbox ack for ${context.conversationId}`,
        );
      }
      acknowledged = true;
      // Joined input is now durable in this Turn. The Turn owns the outcome.
      for (const record of coalesced) {
        await markDispatchCoalesced(record.id);
      }
    };
    if (!dispatch) {
      await acknowledge();
      return { status: "completed" };
    }
    const durableResult = await readDispatchTurnResult(dispatch);
    if (
      durableResult.outcome === "blocked" ||
      durableResult.outcome === "completed" ||
      durableResult.outcome === "failed"
    ) {
      await projectDispatchTurnResult(dispatch.id, durableResult);
      const { held, waiting } = splitJoinedByTurn(dispatch, joined);
      if (waiting.length > 0) {
        // Keep the mailbox, so the next wake starts a Turn for the waiting
        // dispatches.
        for (const record of held) {
          await markDispatchCoalesced(record.id);
        }
        return { status: "deferred", delayMs: 0 };
      }
      await acknowledge();
      return { status: "completed" };
    }
    if (Date.now() - dispatch.createdAtMs > AGENT_DISPATCH_MAX_AGE_MS) {
      for (const record of [...joined, dispatch]) {
        await markDispatchFailed(
          record.id,
          "Dispatch exceeded its maximum processing age",
        );
      }
      await acknowledge();
      return { status: "completed" };
    }

    const resumesDurableTurn = durableResult.hasResumableRun === true;
    const runningDispatch = await markDispatchRunning(
      dispatch.id,
      resumesDurableTurn
        ? {}
        : { joinedDispatchIds: joined.map((record) => record.id) },
    );
    if (!runningDispatch) {
      throw new Error(`Dispatch record disappeared for ${dispatch.id}`);
    }
    if (isTerminalDispatchStatus(runningDispatch.status)) {
      await acknowledge();
      return { status: "completed" };
    }
    // Dispatches that reached the mailbox after the resumed Turn started.
    // Their input is not in that Turn, so the mailbox keeps them for the next.
    let waiting: DispatchRecord[] = [];
    try {
      if (resumesDurableTurn && context.attempt.messages.length > 0) {
        ({ held: coalesced, waiting } = splitJoinedByTurn(
          runningDispatch,
          joined,
        ));
        if (waiting.length === 0) {
          // A durable run proves the original input was already committed.
          // The mailbox item is only a redelivery wake-up and must not
          // restart it.
          await acknowledge();
        } else {
          for (const record of coalesced) {
            await markDispatchCoalesced(record.id);
          }
        }
      }
      let result: DispatchTurnResult;
      if (resumesDurableTurn) {
        await options.resumeTurn(dispatch, {
          shouldYield: context.shouldYield,
        });
        result = await readDispatchTurnResult(dispatch);
      } else {
        const runtimeResult = await options.runTurn(
          joinDispatchInput(dispatch, joined),
          {
            ack: acknowledge,
            shouldYield: context.shouldYield,
          },
        );
        result = runtimeResult.outcome
          ? runtimeResult
          : {
              ...runtimeResult,
              ...(await readDispatchTurnResult(dispatch)),
            };
      }
      if (!result.outcome) {
        throw new Error(
          `Dispatch turn ${dispatch.id} returned without a durable outcome`,
        );
      }
      await projectDispatchTurnResult(dispatch.id, result);
      if (waiting.length > 0) {
        // Leave the mailbox unacknowledged. The next wake starts a Turn for
        // the waiting dispatches after this one finishes.
        return { status: "deferred", delayMs: 0 };
      }
      if (result.outcome && !acknowledged) {
        await acknowledge();
      }
      return result.outcome === "awaiting_resume" && context.shouldYield()
        ? { status: "yielded" }
        : { status: "completed" };
    } catch (error) {
      if (isCooperativeTurnYieldError(error)) {
        await markDispatchAwaitingResume(dispatch.id);
        return { status: "yielded" };
      }
      if (isTurnInputCommitLostError(error)) {
        return { status: "lost_lease" };
      }
      const blockingError = getDispatchBlockingError(error);
      if (blockingError) {
        await persistBlockedDispatchTurn(dispatch, blockingError);
        await acknowledge();
        return { status: "completed" };
      }
      if (!context.attempt.isFinalAttempt) {
        throw error;
      }
      await markDispatchFailed(
        dispatch.id,
        error instanceof Error ? error.message : "Dispatch turn failed",
      );
      await acknowledge();
      return { status: "completed" };
    }
  };
}
