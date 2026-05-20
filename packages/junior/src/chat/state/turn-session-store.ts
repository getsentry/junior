import { isRecord } from "@/chat/coerce";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentTurnUsage } from "@/chat/usage";
import { getStateAdapter } from "./adapter";

const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

function parseAgentTurnSessionCheckpoint(
  value: unknown,
): AgentTurnSessionCheckpoint | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(parsed)) {
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

    return {
      checkpointVersion,
      conversationId,
      sessionId,
      sliceId,
      state: status,
      updatedAtMs,
      ...(cumulativeDurationMs !== undefined ? { cumulativeDurationMs } : {}),
      ...(cumulativeUsage ? { cumulativeUsage } : {}),
      piMessages: Array.isArray(parsed.piMessages)
        ? (parsed.piMessages as PiMessage[])
        : [],
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
    };
  } catch {
    return undefined;
  }
}

export async function getAgentTurnSessionCheckpoint(
  conversationId: string,
  sessionId: string,
): Promise<AgentTurnSessionCheckpoint | undefined> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const value = await stateAdapter.get(
    agentTurnSessionKey(conversationId, sessionId),
  );
  return parseAgentTurnSessionCheckpoint(value);
}

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

  const existing = await getAgentTurnSessionCheckpoint(
    args.conversationId,
    args.sessionId,
  );
  const checkpoint: AgentTurnSessionCheckpoint = {
    checkpointVersion: (existing?.checkpointVersion ?? 0) + 1,
    conversationId: args.conversationId,
    sessionId: args.sessionId,
    sliceId: args.sliceId,
    state: args.state,
    updatedAtMs: Date.now(),
    piMessages: Array.isArray(args.piMessages) ? args.piMessages : [],
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

  const ttlMs = Math.max(1, args.ttlMs ?? AGENT_TURN_SESSION_TTL_MS);
  await stateAdapter.set(
    agentTurnSessionKey(args.conversationId, args.sessionId),
    JSON.stringify(checkpoint),
    ttlMs,
  );
  return checkpoint;
}

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
