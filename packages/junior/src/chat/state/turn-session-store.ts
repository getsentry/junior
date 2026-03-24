import { getStateAdapter } from "./adapter";

const AGENT_TURN_SESSION_PREFIX = "junior:agent_turn_session";
const AGENT_TURN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type AgentTurnSessionStatus =
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed";

export type AgentTurnResumeReason = "timeout" | "auth";

export interface AgentTurnSessionCheckpoint {
  checkpointVersion: number;
  conversationId: string;
  errorMessage?: string;
  loadedSkillNames?: string[];
  piMessages: unknown[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
      status !== "failed"
    ) {
      return undefined;
    }

    const conversationId = parsed.conversationId;
    const sessionId = parsed.sessionId;
    const sliceId = parsed.sliceId;
    const checkpointVersion = parsed.checkpointVersion;
    const updatedAtMs = parsed.updatedAtMs;
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
      piMessages: Array.isArray(parsed.piMessages) ? parsed.piMessages : [],
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
  sessionId: string;
  sliceId: number;
  state: AgentTurnSessionStatus;
  piMessages: unknown[];
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
