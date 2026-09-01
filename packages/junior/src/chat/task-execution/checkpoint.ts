/**
 * Turn checkpoint — public resume cursor for one turn.
 *
 * Part of conversation execution with mailbox + lease + worker.
 * History is SQL (`commitMessages`). This module is the only external gate
 * for turn cursor storage (`turn-cursor.ts` is internal).
 *
 * Public API:
 * - `loadTurnCheckpoint({ conversationId, turnId })`
 * - `saveTurnCheckpoint({ mode, conversationId, turnId, messages, ... })`
 * - fail / abandon / summary helpers for terminal and recovery edges
 */
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { Destination, Actor, Source } from "@sentry/junior-plugin-api";
import { getActiveTraceId, logException } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import {
  isContinuablePiBoundary,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";
import { botConfig } from "@/chat/config";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import { AgentHistoryBranchError } from "@/chat/conversations/projection";
import {
  abandonTurnRecord,
  failTurnRecord,
  getTurnRecord,
  getTurnRecordForResume,
  listTurnSummaries,
  recordTurnSummary,
  upsertTurnRecord,
  type AgentDispatchOutcome,
  type TurnPauseReason,
  type TurnRecord,
  type TurnSummary,
  type AgentTurnSurface,
} from "./turn-cursor";

export type { AgentDispatchOutcome, TurnRecord, TurnSummary, AgentTurnSurface };
export {
  abandonTurnRecord,
  failTurnRecord,
  getTurnRecord,
  listTurnSummaries,
  recordTurnSummary,
};

/** Loaded resume cursor. A resumed checkpoint always has its record. */
export type TurnCheckpoint =
  | {
      resumed: true;
      sliceId: number;
      record: TurnRecord;
    }
  | {
      resumed: false;
      sliceId: 1;
      record?: TurnRecord;
    };

/**
 * Lifecycle fields for a checkpoint write.
 * Routing/metrics/provenance are only for SQL dual-write / resume restore.
 * Profile, reasoning, concrete model id, and skills are not checkpoint fields.
 */
interface TurnCheckpointWrite {
  conversationId: string;
  turnId: string;
  messages: PiMessage[];
  /** Required for running/paused; optional for completed/failed (falls back to stored). */
  sliceId?: number;
  // --- SQL dual-write / restore only ---
  actor?: Actor;
  channelName?: string;
  destination?: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  dispatchOutcome?: AgentDispatchOutcome;
  source?: Source;
  surface?: AgentTurnSurface;
  turnStartMessageIndex?: number;
  /** Tool calls charged to this turn; survives history replacement. */
  cumulativeToolCallCount?: number;
  trailingMessageProvenance?: ConversationMessageProvenance[];
  turnContexts?: PluginTurnContext[];
  durationMs?: number;
  usage?: AgentTurnUsage;
  errorMessage?: string;
  resultMessageId?: string;
}

type ProgressCheckpointArgs =
  | (TurnCheckpointWrite & { mode: "running"; sliceId: number })
  | (TurnCheckpointWrite & {
      mode: "paused";
      reason: TurnPauseReason;
      sliceId: number;
    });

type TerminalCheckpointArgs = TurnCheckpointWrite & {
  mode: "completed" | "failed";
};

type SaveTurnCheckpointArgs = ProgressCheckpointArgs | TerminalCheckpointArgs;

function definedProps<T extends Record<string, unknown>>(
  values: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function addDurationMs(
  prior: number | undefined,
  current: number | undefined,
): number | undefined {
  const total = [prior, current].reduce<number | undefined>((sum, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return sum;
    }
    return (sum ?? 0) + Math.max(0, Math.floor(value));
  }, undefined);
  return total;
}

/** Boundary safe to continue after auth/timeout (trim mid-assistant). */
export function continuableMessages(
  messages: PiMessage[],
  fallback?: PiMessage[],
): PiMessage[] {
  const current = trimTrailingAssistantMessages(messages);
  if (current.length > 0 && isContinuablePiBoundary(current)) {
    return current;
  }
  return trimTrailingAssistantMessages(fallback ?? []);
}

/** Load resume cursor for one turn. */
export async function loadTurnCheckpoint(args: {
  conversationId: string;
  turnId: string;
}): Promise<TurnCheckpoint> {
  const record = await getTurnRecordForResume(args.conversationId, args.turnId);
  if (record?.state === "paused") {
    return { resumed: true, sliceId: record.sliceId, record };
  }
  return { resumed: false, sliceId: 1, record };
}

/**
 * Save turn progress.
 *
 * - `running` / `paused`: best-effort; returns the stored record or undefined
 * - `completed` / `failed`: retries until write accepts; throws on hard failure
 */
export function saveTurnCheckpoint(
  args: ProgressCheckpointArgs,
): Promise<TurnRecord | undefined>;
export function saveTurnCheckpoint(args: TerminalCheckpointArgs): Promise<void>;
export async function saveTurnCheckpoint(
  args: SaveTurnCheckpointArgs,
): Promise<TurnRecord | undefined | void> {
  if (args.mode === "running") {
    return await saveRunning(args);
  }
  if (args.mode === "paused") {
    return await savePaused(args);
  }
  await saveDone(args);
  return undefined;
}

function sharedWrite(args: TurnCheckpointWrite, latest?: TurnRecord) {
  return {
    conversationId: args.conversationId,
    turnId: args.turnId,
    ...definedProps({
      actor: args.actor,
      channelName: args.channelName ?? latest?.channelName,
      destination: args.destination,
      destinationVisibility: args.destinationVisibility,
      dispatchId: args.dispatchId ?? latest?.dispatchId,
      source: args.source,
      surface: args.surface ?? latest?.surface,
      traceId: getActiveTraceId() ?? latest?.traceId,
      turnStartMessageIndex:
        args.turnStartMessageIndex ?? latest?.turnStartMessageIndex,
      cumulativeToolCallCount:
        args.cumulativeToolCallCount ?? latest?.cumulativeToolCallCount,
    }),
  };
}

async function saveRunning(
  args: Extract<SaveTurnCheckpointArgs, { mode: "running" }>,
): Promise<TurnRecord | undefined> {
  if (args.messages.length === 0 || !isContinuablePiBoundary(args.messages)) {
    return undefined;
  }
  try {
    const latest = await getTurnRecord(args.conversationId, args.turnId);
    return await upsertTurnRecord({
      ...sharedWrite(args, latest),
      ...definedProps({
        trailingMessageProvenance: args.trailingMessageProvenance,
        turnContexts: args.turnContexts,
      }),
      cumulativeDurationMs: latest?.cumulativeDurationMs,
      cumulativeUsage: latest?.cumulativeUsage,
      piMessages: args.messages,
      sliceId: args.sliceId,
      state: "running",
    });
  } catch (error) {
    // Quiet only branch races on best-effort running checkpoints.
    if (!(error instanceof AgentHistoryBranchError)) {
      logException(error, "agent.turn.checkpoint.running.failed", {
        "app.ai.resume_conversation_id": args.conversationId,
        "app.ai.resume_session_id": args.turnId,
        "app.ai.resume_slice_id": args.sliceId,
      });
    }
    return undefined;
  }
}

async function savePaused(
  args: Extract<SaveTurnCheckpointArgs, { mode: "paused" }>,
): Promise<TurnRecord | undefined> {
  // Yield keeps the current slice; auth/timeout/retry advance it.
  const keepSlice = args.reason === "yield";
  const nextSliceId = keepSlice ? args.sliceId : args.sliceId + 1;
  try {
    const latest = await getTurnRecord(args.conversationId, args.turnId);
    const messages =
      args.reason === "yield"
        ? [...args.messages]
        : continuableMessages(args.messages, latest?.piMessages);

    if (args.reason === "auth") {
      if (messages.length > 0 && !isContinuablePiBoundary(messages)) {
        return undefined;
      }
    } else if (messages.length === 0 || !isContinuablePiBoundary(messages)) {
      return undefined;
    }

    const base = {
      ...sharedWrite(args, latest),
      ...definedProps({
        cumulativeDurationMs: addDurationMs(
          latest?.cumulativeDurationMs,
          args.durationMs,
        ),
        cumulativeUsage: addAgentTurnUsage(latest?.cumulativeUsage, args.usage),
        errorMessage: args.errorMessage,
      }),
      piMessages: messages,
      resumeReason: args.reason,
    };

    if (!keepSlice && nextSliceId > botConfig.maxSlicesPerTurn) {
      const error = new TurnSliceLimitExceededError(botConfig.maxSlicesPerTurn);
      await upsertTurnRecord({
        ...base,
        ...definedProps({ resumedFromSliceId: latest?.resumedFromSliceId }),
        errorMessage: error.message,
        sliceId: args.sliceId,
        state: "failed",
      });
      throw error;
    }

    return await upsertTurnRecord({
      ...base,
      ...definedProps({
        resumedFromSliceId: keepSlice
          ? latest?.resumedFromSliceId
          : args.sliceId,
      }),
      sliceId: nextSliceId,
      // Stored name is historical; means "paused, may continue".
      state: "paused",
    });
  } catch (error) {
    if (error instanceof TurnSliceLimitExceededError) {
      throw error;
    }
    logException(error, "agent.turn.checkpoint.paused.failed", {
      "app.ai.resume_conversation_id": args.conversationId,
      "app.ai.resume_session_id": args.turnId,
      "app.ai.resume_from_slice_id": args.sliceId,
      "app.ai.resume_next_slice_id": nextSliceId,
      "app.ai.resume_reason": args.reason,
    });
    return undefined;
  }
}

async function saveDone(
  args: Extract<SaveTurnCheckpointArgs, { mode: "completed" | "failed" }>,
): Promise<void> {
  let latest: TurnRecord | undefined;
  await persistWithRetry(async () => {
    latest = await getTurnRecord(args.conversationId, args.turnId);
  });
  const sliceId = args.sliceId ?? latest?.sliceId;
  if (sliceId === undefined) {
    throw new Error(
      "Completed turn checkpoint requires a slice id from the caller or the latest stored record",
    );
  }
  await persistWithRetry(async () => {
    await upsertTurnRecord({
      ...sharedWrite(args, latest),
      ...definedProps({
        cumulativeDurationMs: addDurationMs(
          latest?.cumulativeDurationMs,
          args.durationMs,
        ),
        cumulativeUsage: addAgentTurnUsage(latest?.cumulativeUsage, args.usage),
        dispatchOutcome: args.dispatchOutcome ?? latest?.dispatchOutcome,
        errorMessage: args.errorMessage,
        resultMessageId: args.resultMessageId ?? latest?.resultMessageId,
      }),
      piMessages: args.messages,
      sliceId,
      state: args.mode,
    });
  });
}
