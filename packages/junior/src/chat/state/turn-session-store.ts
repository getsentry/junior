import { THREAD_STATE_TTL_MS } from "chat";
import { isRecord } from "@/chat/coerce";
import type { PiMessage } from "@/chat/pi/messages";
import {
  commitPiSessionMessages,
  loadPiSessionMessages,
} from "./pi-session-message-store";
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";

const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_TTL_MS = THREAD_STATE_TTL_MS;

export type AgentTurnSessionStatus =
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "superseded";

export type AgentTurnResumeReason = "timeout" | "auth";

export interface AgentTurnSessionCheckpoint {
  checkpointVersion: number;
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  errorMessage?: string;
  loadedSkillNames?: string[];
  piMessages: PiMessage[];
  resumeReason?: AgentTurnResumeReason;
  resumedFromSliceId?: number;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  updatedAtMs: number;
}

interface AgentTurnSessionRecord extends Omit<
  AgentTurnSessionCheckpoint,
  "piMessages"
> {
  messageCount: number;
}

function agentTurnSessionKey(
  conversationId: string,
  sessionId: string,
): string {
  return `${AGENT_TURN_SESSION_PREFIX}:${conversationId}:${sessionId}`;
}

function toFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function parseAgentTurnUsage(value: unknown): AgentTurnUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage: AgentTurnUsage = {};
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "totalTokens",
  ] as const) {
    const count = toFiniteNonNegativeNumber(value[field]);
    if (count !== undefined) {
      usage[field] = count;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseStoredRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseAgentTurnSessionRecord(value: unknown):
  | {
      legacyPiMessages: PiMessage[];
      record: AgentTurnSessionRecord;
    }
  | undefined {
  const parsed = parseStoredRecord(value);
  if (!parsed) {
    return undefined;
  }

  const status = parsed.state;
  if (
    status !== "running" &&
    status !== "awaiting_resume" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "superseded"
  ) {
    return undefined;
  }

  const conversationId = parsed.conversationId;
  const sessionId = parsed.sessionId;
  const sliceId = parsed.sliceId;
  const checkpointVersion = parsed.checkpointVersion;
  const updatedAtMs = parsed.updatedAtMs;
  const cumulativeDurationMs = toFiniteNonNegativeNumber(
    parsed.cumulativeDurationMs,
  );
  const cumulativeUsage = parseAgentTurnUsage(parsed.cumulativeUsage);
  if (
    typeof conversationId !== "string" ||
    typeof sessionId !== "string" ||
    typeof sliceId !== "number" ||
    typeof checkpointVersion !== "number" ||
    typeof updatedAtMs !== "number"
  ) {
    return undefined;
  }

  const legacyPiMessages = Array.isArray(parsed.piMessages)
    ? (parsed.piMessages as PiMessage[])
    : [];
  const messageCount =
    toFiniteNonNegativeNumber(parsed.messageCount) ?? legacyPiMessages.length;

  return {
    legacyPiMessages,
    record: {
      checkpointVersion,
      conversationId,
      sessionId,
      sliceId,
      state: status,
      updatedAtMs,
      messageCount,
      ...(cumulativeDurationMs !== undefined ? { cumulativeDurationMs } : {}),
      ...(cumulativeUsage ? { cumulativeUsage } : {}),
      ...(Array.isArray(parsed.loadedSkillNames)
        ? {
            loadedSkillNames: parsed.loadedSkillNames.filter(
              (value): value is string => typeof value === "string",
            ),
          }
        : {}),
      ...(parsed.resumeReason === "timeout" || parsed.resumeReason === "auth"
        ? { resumeReason: parsed.resumeReason }
        : {}),
      ...(typeof parsed.errorMessage === "string"
        ? { errorMessage: parsed.errorMessage }
        : {}),
      ...(typeof parsed.resumedFromSliceId === "number"
        ? { resumedFromSliceId: parsed.resumedFromSliceId }
        : {}),
    },
  };
}

function materializePiMessages(
  legacyPiMessages: PiMessage[],
  messageCount: number,
  sessionMessages?: PiMessage[],
): PiMessage[] | undefined {
  if (messageCount === 0) {
    return [];
  }
  if (sessionMessages) {
    return sessionMessages;
  }
  if (legacyPiMessages.length >= messageCount) {
    return legacyPiMessages.slice(0, messageCount);
  }
  return undefined;
}

/** Read a materialized turn-session checkpoint for resume and history loading. */
export async function getAgentTurnSessionCheckpoint(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionCheckpoint | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const value = await stateAdapter.get(
    agentTurnSessionKey(conversationId, sessionId),
  );
  const parsed = parseAgentTurnSessionRecord(value);
  if (!parsed) {
    return undefined;
  }

  const sessionMessages = await loadPiSessionMessages({
    conversationId,
    sessionId,
    messageCount: parsed.record.messageCount,
  });
  const piMessages = materializePiMessages(
    parsed.legacyPiMessages,
    parsed.record.messageCount,
    sessionMessages,
  );
  if (!piMessages) {
    return undefined;
  }

  return {
    ...parsed.record,
    piMessages,
  };
}

/** Commit stable Pi session state and advance the turn-session checkpoint cursor. */
export async function upsertAgentTurnSessionCheckpoint(args: {
  conversationId: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  piMessages: PiMessage[];
  loadedSkillNames?: string[];
  resumeReason?: AgentTurnResumeReason;
  errorMessage?: string;
  resumedFromSliceId?: number;
  ttlMs?: number;
}): Promise<AgentTurnSessionCheckpoint> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();

  const existingValue = await stateAdapter.get(
    agentTurnSessionKey(args.conversationId, args.sessionId),
  );
  const existingRecord = parseAgentTurnSessionRecord(existingValue);
  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  await commitPiSessionMessages({
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    messages: args.piMessages,
    ttlMs,
  });
  const storedMessageCount = args.piMessages.length;

  const checkpoint: AgentTurnSessionRecord = {
    checkpointVersion: (existingRecord?.record.checkpointVersion ?? 0) + 1,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    updatedAtMs: Date.now(),
    messageCount: storedMessageCount,
    ...(typeof args.cumulativeDurationMs === "number" &&
    Number.isFinite(args.cumulativeDurationMs)
      ? {
          cumulativeDurationMs: Math.max(
            0,
            Math.floor(args.cumulativeDurationMs),
          ),
        }
      : {}),
    ...(args.cumulativeUsage ? { cumulativeUsage: args.cumulativeUsage } : {}),
    ...(Array.isArray(args.loadedSkillNames)
      ? {
          loadedSkillNames: args.loadedSkillNames.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(args.resumeReason ? { resumeReason: args.resumeReason } : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(typeof args.resumedFromSliceId === "number"
      ? { resumedFromSliceId: args.resumedFromSliceId }
      : {}),
  };

  await stateAdapter.set(
    agentTurnSessionKey(args.conversationId, args.sessionId),
    checkpoint,
    ttlMs,
  );
  return {
    ...checkpoint,
    piMessages: [...args.piMessages],
  };
}

/** Mark an unfinished turn-session checkpoint as superseded when a newer turn wins. */
export async function supersedeAgentTurnSessionCheckpoint(args: {
  conversationId: string;
  sessionId: string;
  errorMessage?: string;
}): Promise<AgentTurnSessionCheckpoint | undefined> {
  const existing = await getAgentTurnSessionCheckpoint(
    args.conversationId,
    args.sessionId,
  );
  if (
    !existing ||
    existing.state === "completed" ||
    existing.state === "failed" ||
    existing.state === "superseded"
  ) {
    return undefined;
  }

  return await upsertAgentTurnSessionCheckpoint({
    conversationId: existing.conversationId,
    sessionId: existing.sessionId,
    sliceId: existing.sliceId,
    state: "superseded",
    piMessages: existing.piMessages,
    cumulativeDurationMs: existing.cumulativeDurationMs,
    cumulativeUsage: existing.cumulativeUsage,
    loadedSkillNames: existing.loadedSkillNames,
    resumeReason: existing.resumeReason,
    resumedFromSliceId: existing.resumedFromSliceId,
    errorMessage: args.errorMessage ?? existing.errorMessage,
  });
}
