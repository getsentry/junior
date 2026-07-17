/**
 * Run resumability.
 *
 * Owns the durable state that lets a run slice stop without losing work:
 * safe-boundary checkpoints, the durable input commit, resume snapshots, and
 * persistence of the expected endings (cooperative yield, continuable
 * timeout, auth pause) translated into `AgentRunOutcome` values so the
 * executor's catch block stays a thin translation over genuine errors.
 */
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import type { PiMessage } from "@/chat/pi/messages";
import type { PiMessageProvenance } from "@/chat/state/session-log";
import {
  CooperativeTurnYieldError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { Actor } from "@/chat/actor";
import {
  loadTurnSessionRecord,
  persistAuthPauseSessionRecord,
  persistRunningSessionRecord,
  persistTimeoutSessionRecord,
  persistYieldSessionRecord,
} from "@/chat/services/turn-session-record";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { extractGenAiUsageSummary } from "@/chat/logging";
import { isAssistantMessage } from "@/chat/pi/transcript";
import type { AgentRunDurability } from "@/chat/agent/request";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;
type SessionRecordLogContext = NonNullable<
  Parameters<typeof persistRunningSessionRecord>[0]["logContext"]
>;

interface ResumeStateArgs {
  channelName?: string;
  destination: Destination;
  durability: AgentRunDurability;
  getLoadedSkillNames: () => string[];
  getModelId: () => string;
  logContext: SessionRecordLogContext;
  getReasoningLevel: () => string | undefined;
  recordActiveMcpProviders: () => Promise<void>;
  actor?: Actor;
  runSource: Source;
  sessionConversationId?: string;
  sessionId?: string;
  sessionRecordState: LoadedSessionRecordState;
  startedAtMs: number;
  surface?: AgentTurnSurface;
}

interface ExpectedEndingTranslation {
  outcome?: AgentRunOutcome;
}

function extractSliceUsage(
  messages: PiMessage[],
  beforeMessageCount: number,
): AgentTurnUsage | undefined {
  const usage = extractGenAiUsageSummary(
    ...messages.slice(beforeMessageCount).filter(isAssistantMessage),
  );
  return hasAgentTurnUsage(usage) ? usage : undefined;
}

/** Create the run's resume state: checkpoints, snapshots, and ending translation. */
export function createResumeState(args: ResumeStateArgs) {
  let beforeMessageCount = 0;
  let cooperativeYieldError: CooperativeTurnYieldError | undefined;
  let inputCommitted = false;
  let latestSafeBoundaryMessages: PiMessage[] = [];
  let timedOut = false;
  let resumeMessages: PiMessage[] = [];
  let turnStartMessageIndex: number | undefined;

  const currentSliceId = args.sessionRecordState.currentSliceId;
  const canPersistSession =
    args.sessionRecordState.canUseTurnSession &&
    Boolean(args.sessionConversationId && args.sessionId);

  const currentDurationMs = () => Date.now() - args.startedAtMs;

  const sessionRecordBase = () => ({
    channelName: args.channelName,
    conversationId: args.sessionConversationId!,
    destination: args.destination,
    source: args.runSource,
    sessionId: args.sessionId!,
    loadedSkillNames: args.getLoadedSkillNames(),
    logContext: args.logContext,
    modelId: args.getModelId(),
    ...(args.getReasoningLevel()
      ? { reasoningLevel: args.getReasoningLevel() }
      : {}),
    actor: args.actor,
    ...(args.surface ? { surface: args.surface } : {}),
  });

  return {
    get inputCommitted(): boolean {
      return inputCommitted;
    },
    get beforeMessageCount(): number {
      return beforeMessageCount;
    },
    get timedOut(): boolean {
      return timedOut;
    },
    get cooperativeYieldError(): CooperativeTurnYieldError | undefined {
      return cooperativeYieldError;
    },
    setTurnStartMessageIndex(index: number | undefined): void {
      turnStartMessageIndex = index;
    },
    setBeforeMessageCount(count: number): void {
      beforeMessageCount = count;
    },
    /** Adopt an already committed epoch replacement as every resume baseline. */
    adoptCommittedBoundary(messages: PiMessage[]): void {
      latestSafeBoundaryMessages = [...messages];
      resumeMessages = [...messages];
    },
    captureResumeSnapshot(messages: PiMessage[]): void {
      resumeMessages = [...messages];
    },
    getResumeSnapshot(currentMessages: PiMessage[]): PiMessage[] {
      return latestSafeBoundaryMessages.length > currentMessages.length
        ? [...latestSafeBoundaryMessages]
        : [...currentMessages];
    },
    markTimedOut(): void {
      timedOut = true;
    },
    async commitInput(): Promise<void> {
      if (inputCommitted) {
        return;
      }
      await args.durability.onInputCommitted?.();
      inputCommitted = true;
    },
    async persistSafeBoundary(
      messages: PiMessage[],
      trailingMessageProvenance?: PiMessageProvenance[],
    ): Promise<boolean> {
      if (!canPersistSession) {
        return false;
      }

      const persisted = await persistRunningSessionRecord({
        ...sessionRecordBase(),
        sliceId: currentSliceId,
        messages,
        ...(trailingMessageProvenance ? { trailingMessageProvenance } : {}),
        ...(turnStartMessageIndex !== undefined
          ? { turnStartMessageIndex }
          : {}),
      });
      if (!persisted) {
        return false;
      }

      latestSafeBoundaryMessages = [...messages];
      return true;
    },
    async requireDurableInputCheckpoint(
      messages: PiMessage[],
      trailingMessageProvenance?: PiMessageProvenance[],
    ): Promise<boolean> {
      const persisted = await this.persistSafeBoundary(
        messages,
        trailingMessageProvenance,
      );
      if (!persisted && args.durability.onInputCommitted) {
        throw new TurnInputCommitLostError(
          `Durable turn input could not be checkpointed for conversation=${args.sessionConversationId ?? "unknown"} session=${args.sessionId ?? "unknown"}`,
        );
      }
      return persisted;
    },
    yieldAtSafeBoundaryIfDue(currentMessages: PiMessage[]): void {
      if (!args.durability.shouldYield?.()) {
        return;
      }

      resumeMessages = this.getResumeSnapshot(currentMessages);
      cooperativeYieldError = new CooperativeTurnYieldError(
        `Agent turn yielded at a safe boundary after ${currentDurationMs()}ms`,
      );
      throw cooperativeYieldError;
    },
    /**
     * Persist the continuation for an expected run ending and translate it
     * into an outcome; returns no outcome for genuine errors so the caller's
     * error guards run.
     */
    async translateExpectedEnding(args2: {
      currentUsage?: AgentTurnUsage;
      error: unknown;
    }): Promise<ExpectedEndingTranslation> {
      const { error } = args2;
      if (!args.sessionConversationId || !args.sessionId) {
        return {};
      }

      if (cooperativeYieldError && error instanceof CooperativeTurnYieldError) {
        const usage =
          args2.currentUsage ??
          extractSliceUsage(resumeMessages, beforeMessageCount);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistYieldSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: resumeMessages,
          errorMessage: error.message,
        });
        if (!sessionRecord) {
          throw new Error(
            `Failed to persist cooperative yield continuation for conversation=${args.sessionConversationId} session=${args.sessionId}`,
          );
        }
        return {
          outcome: {
            status: "suspended",
            resumeVersion: sessionRecord.version,
            ...(usage ? { usage } : {}),
          },
        };
      }

      if (timedOut) {
        const usage =
          args2.currentUsage ??
          extractSliceUsage(resumeMessages, beforeMessageCount);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistTimeoutSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: resumeMessages,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (!sessionRecord) {
          throw new Error(
            `Failed to persist timeout continuation for conversation=${args.sessionConversationId} session=${args.sessionId}`,
          );
        }
        if (sessionRecord.state === "awaiting_resume") {
          return {
            outcome: {
              status: "suspended",
              resumeVersion: sessionRecord.version,
              ...(usage ? { usage } : {}),
            },
          };
        }
        throw new TurnSliceLimitExceededError(botConfig.maxSlicesPerTurn);
      }

      if (error instanceof AuthorizationPauseError) {
        const usage =
          args2.currentUsage ??
          (resumeMessages.length > 0
            ? extractSliceUsage(resumeMessages, beforeMessageCount)
            : undefined);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistAuthPauseSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: resumeMessages,
          errorMessage: error.message,
        });
        if (sessionRecord) {
          return {
            outcome: {
              status: "awaiting_auth",
              providerDisplayName: error.providerDisplayName,
              ...(usage ? { usage } : {}),
            },
          };
        }
      }

      return {};
    },
  };
}

export type ResumeState = ReturnType<typeof createResumeState>;
