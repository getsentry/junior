import type { AssistantReply } from "@/chat/services/turn-result";
import type {
  AuthorizationPauseDisposition,
  AuthorizationPauseKind,
} from "@/chat/services/auth-pause";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  RetryableTurnError,
  type AuthResumeRetryableTurnError,
} from "@/chat/runtime/turn";

export interface AgentRunContinuationIds {
  conversationId: string;
  sessionId: string;
  sliceId: number;
  version?: number;
}

export interface AgentRunAuthPauseMetadata extends AgentRunContinuationIds {
  authDisposition: AuthorizationPauseDisposition;
  authDurationMs: number;
  authKind: AuthorizationPauseKind;
  authProvider: string;
  authProviderDisplayName: string;
  authThinkingLevel?: TurnThinkingSelection["thinkingLevel"];
  authUsage?: AgentTurnUsage;
}

export type AgentRunOutcome =
  | { status: "completed"; reply: AssistantReply }
  | { status: "failed"; reply: AssistantReply }
  | ({ status: "yielded" } & AgentRunContinuationIds)
  | ({ status: "timed_out" } & AgentRunContinuationIds)
  | ({ status: "awaiting_auth" } & Omit<AgentRunAuthPauseMetadata, "version">);

/** Return a successful final reply as an agent-run outcome. */
export function completedAgentRun(reply: AssistantReply): AgentRunOutcome {
  return { status: "completed", reply };
}

/** Return a terminal provider-failure reply as an agent-run outcome. */
export function failedAgentRun(reply: AssistantReply): AgentRunOutcome {
  return { status: "failed", reply };
}

/** Recreate the historical timeout continuation error at outer boundaries. */
export function retryableTurnErrorFromTimedOutAgentRun(
  outcome: Extract<AgentRunOutcome, { status: "timed_out" }>,
): RetryableTurnError {
  return new RetryableTurnError(
    "agent_continue",
    `conversation=${outcome.conversationId} session=${outcome.sessionId} slice=${outcome.sliceId} version=${outcome.version}`,
    {
      conversationId: outcome.conversationId,
      sessionId: outcome.sessionId,
      sliceId: outcome.sliceId,
      version: outcome.version,
    },
  );
}

/** Recreate the historical auth-pause error for callback APIs not yet migrated. */
export function retryableTurnErrorFromAuthAgentRun(
  outcome: Extract<AgentRunOutcome, { status: "awaiting_auth" }>,
): AuthResumeRetryableTurnError {
  return new RetryableTurnError(
    outcome.authKind === "plugin" ? "plugin_auth_resume" : "mcp_auth_resume",
    `conversation=${outcome.conversationId} session=${outcome.sessionId} slice=${outcome.sliceId}`,
    {
      authDisposition: outcome.authDisposition,
      authDurationMs: outcome.authDurationMs,
      authKind: outcome.authKind,
      authProvider: outcome.authProvider,
      authProviderDisplayName: outcome.authProviderDisplayName,
      authThinkingLevel: outcome.authThinkingLevel,
      authUsage: outcome.authUsage,
      conversationId: outcome.conversationId,
      sessionId: outcome.sessionId,
      sliceId: outcome.sliceId,
    },
  ) as AuthResumeRetryableTurnError;
}
