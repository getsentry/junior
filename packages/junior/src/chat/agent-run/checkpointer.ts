import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import {
  CooperativeTurnYieldError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { Requester } from "@/chat/requester";
import {
  loadTurnSessionRecord,
  persistAuthPauseSessionRecord,
  persistRunningSessionRecord,
  persistTimeoutSessionRecord,
  persistYieldSessionRecord,
} from "@/chat/services/turn-session-record";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { extractGenAiUsageSummary } from "@/chat/logging";
import { isAssistantMessage } from "@/chat/agent-run-helpers";
import type { AgentRunDurability } from "@/chat/agent-run/request";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;
type SessionRecordLogContext = NonNullable<
  Parameters<typeof persistRunningSessionRecord>[0]["logContext"]
>;

interface SliceCheckpointerArgs {
  channelName?: string;
  destination: Destination;
  durability: AgentRunDurability;
  logContext: SessionRecordLogContext;
  recordActiveMcpProviders: () => Promise<void>;
  requester?: Requester;
  runSource: Source;
  sessionConversationId?: string;
  sessionId?: string;
  startedAtMs: number;
  surface?: AgentTurnSurface;
  sessionRecordState: LoadedSessionRecordState;
  getLoadedSkillNames: () => string[];
}

interface ExpectedEndingTranslationArgs {
  currentUsage?: AgentTurnUsage;
  error: unknown;
  thinkingSelection?: TurnThinkingSelection;
}

interface ExpectedEndingTranslation {
  outcome?: AgentRunOutcome;
  usage?: AgentTurnUsage;
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

/** Owns durable safe-boundary checkpoints and expected slice-ending persistence. */
export function createSliceCheckpointer(args: SliceCheckpointerArgs) {
  let beforeMessageCount = 0;
  let cooperativeYieldError: CooperativeTurnYieldError | undefined;
  let inputCommitted = false;
  let latestSafeBoundaryMessages: PiMessage[] = [];
  let timedOut = false;
  let timeoutResumeMessages: PiMessage[] = [];
  let turnStartMessageIndex: number | undefined;

  const currentSliceId = args.sessionRecordState.currentSliceId;
  const canPersistSession =
    args.sessionRecordState.canUseTurnSession &&
    Boolean(args.sessionConversationId && args.sessionId);

  const currentDurationMs = () => Date.now() - args.startedAtMs;
  const currentUsage = (
    existingUsage: AgentTurnUsage | undefined,
  ): AgentTurnUsage | undefined =>
    existingUsage ??
    extractSliceUsage(timeoutResumeMessages, beforeMessageCount);

  const sessionRecordBase = () => ({
    channelName: args.channelName,
    conversationId: args.sessionConversationId!,
    destination: args.destination,
    source: args.runSource,
    sessionId: args.sessionId!,
    loadedSkillNames: args.getLoadedSkillNames(),
    logContext: args.logContext,
    requester: args.requester,
    ...(args.surface ? { surface: args.surface } : {}),
  });

  return {
    get cooperativeYieldError(): CooperativeTurnYieldError | undefined {
      return cooperativeYieldError;
    },
    get inputCommitted(): boolean {
      return inputCommitted;
    },
    get beforeMessageCount(): number {
      return beforeMessageCount;
    },
    get timedOut(): boolean {
      return timedOut;
    },
    setRunStartMessageIndex(index: number | undefined): void {
      turnStartMessageIndex = index;
    },
    setBeforeMessageCount(count: number): void {
      beforeMessageCount = count;
    },
    resetResumeSnapshot(): void {
      timeoutResumeMessages = [];
    },
    captureResumeSnapshot(messages: PiMessage[]): void {
      timeoutResumeMessages = [...messages];
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
    async persistSafeBoundary(messages: PiMessage[]): Promise<boolean> {
      if (!canPersistSession) {
        return false;
      }

      const persisted = await persistRunningSessionRecord({
        ...sessionRecordBase(),
        sliceId: currentSliceId,
        messages,
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
    ): Promise<boolean> {
      const persisted = await this.persistSafeBoundary(messages);
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

      timeoutResumeMessages = this.getResumeSnapshot(currentMessages);
      cooperativeYieldError = new CooperativeTurnYieldError(
        `Agent turn yielded at a safe boundary after ${currentDurationMs()}ms`,
      );
      throw cooperativeYieldError;
    },
    async translateExpectedEnding({
      currentUsage: existingUsage,
      error,
      thinkingSelection,
    }: ExpectedEndingTranslationArgs): Promise<ExpectedEndingTranslation> {
      if (!args.sessionConversationId || !args.sessionId) {
        return {};
      }

      if (cooperativeYieldError && error instanceof CooperativeTurnYieldError) {
        const usage = currentUsage(existingUsage);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistYieldSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: timeoutResumeMessages,
          errorMessage: error.message,
        });
        if (!sessionRecord) {
          throw new Error(
            `Failed to persist cooperative yield continuation for conversation=${args.sessionConversationId} session=${args.sessionId}`,
          );
        }
        return {
          usage,
          outcome: {
            status: "yielded",
            conversationId: args.sessionConversationId,
            sessionId: args.sessionId,
            sliceId: sessionRecord.sliceId,
            version: sessionRecord.version,
          },
        };
      }

      if (timedOut) {
        const usage = currentUsage(existingUsage);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistTimeoutSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: timeoutResumeMessages,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (!sessionRecord) {
          throw new Error(
            `Failed to persist timeout continuation for conversation=${args.sessionConversationId} session=${args.sessionId}`,
          );
        }
        if (sessionRecord.state === "awaiting_resume") {
          return {
            usage,
            outcome: {
              status: "timed_out",
              conversationId: args.sessionConversationId,
              sessionId: args.sessionId,
              sliceId: sessionRecord.sliceId,
              version: sessionRecord.version,
            },
          };
        }
        throw new Error(
          sessionRecord.errorMessage ??
            (error instanceof Error ? error.message : String(error)),
        );
      }

      if (error instanceof AuthorizationPauseError) {
        const usage =
          existingUsage ??
          (timeoutResumeMessages.length > 0
            ? extractSliceUsage(timeoutResumeMessages, beforeMessageCount)
            : undefined);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistAuthPauseSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: timeoutResumeMessages,
          errorMessage: error.message,
        });
        if (sessionRecord) {
          return {
            usage,
            outcome: {
              status: "awaiting_auth",
              authDisposition: error.disposition,
              authDurationMs: currentDurationMs(),
              authKind: error.kind,
              authProvider: error.provider,
              authProviderDisplayName: error.providerDisplayName,
              authThinkingLevel: thinkingSelection?.thinkingLevel,
              authUsage: usage,
              conversationId: args.sessionConversationId,
              sessionId: args.sessionId,
              sliceId: sessionRecord.sliceId,
            },
          };
        }
      }

      return {};
    },
  };
}

export type SliceCheckpointer = ReturnType<typeof createSliceCheckpointer>;
