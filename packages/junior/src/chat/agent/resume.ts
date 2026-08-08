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
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
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
  persistContinuationSessionRecord,
  persistRunningSessionRecord,
  persistYieldSessionRecord,
} from "@/chat/services/turn-session-record";
import {
  AuthPausePersistenceError,
  type AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { extractGenAiUsageSummary } from "@/chat/logging";
import {
  isAssistantMessage,
  isContinuablePiBoundary,
} from "@/chat/pi/transcript";
import {
  RetryableDeliveryError,
  type AgentRunDurability,
} from "@/chat/agent/request";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

type LoadedSessionRecordState = Awaited<
  ReturnType<typeof loadTurnSessionRecord>
>;
interface ResumeStateArgs {
  channelName?: string;
  destination: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  durability: AgentRunDurability;
  recordActiveMcpProviders: () => Promise<void>;
  actor?: Actor;
  runSource: Source;
  conversationId: string;
  turnId: string;
  sessionRecordState: LoadedSessionRecordState;
  startedAtMs: number;
  surface: AgentTurnSurface;
}

type AuthPauseOutcome = Extract<AgentRunOutcome, { status: "awaiting_auth" }>;

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
  let inputCommitted = false;
  let latestSafeBoundaryMessages: PiMessage[] = [];
  let timedOut = false;
  let resumeMessages: PiMessage[] = [];
  let turnContexts: PluginTurnContext[] = [];
  let turnStartMessageIndex: number | undefined;

  const currentSliceId = args.sessionRecordState.currentSliceId;
  const currentDurationMs = () => Date.now() - args.startedAtMs;

  const sessionRecordBase = () => ({
    channelName: args.channelName,
    conversationId: args.conversationId,
    destination: args.destination,
    ...(args.destinationVisibility
      ? { destinationVisibility: args.destinationVisibility }
      : {}),
    ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    source: args.runSource,
    sessionId: args.turnId,
    actor: args.actor,
    surface: args.surface,
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
    setTurnStartMessageIndex(index: number | undefined): void {
      turnStartMessageIndex = index;
    },
    setBeforeMessageCount(count: number): void {
      beforeMessageCount = count;
    },
    setTurnContexts(contexts: PluginTurnContext[]): void {
      turnContexts = contexts;
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
      trailingMessageProvenance?: ConversationMessageProvenance[],
    ): Promise<boolean> {
      const persisted = await persistRunningSessionRecord({
        ...sessionRecordBase(),
        sliceId: currentSliceId,
        messages,
        ...(trailingMessageProvenance ? { trailingMessageProvenance } : {}),
        ...(turnContexts.length > 0 ? { turnContexts } : {}),
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
      trailingMessageProvenance?: ConversationMessageProvenance[],
    ): Promise<boolean> {
      const persisted = await this.persistSafeBoundary(
        messages,
        trailingMessageProvenance,
      );
      if (!persisted && args.durability.onInputCommitted) {
        throw new TurnInputCommitLostError(
          `Durable turn input could not be checkpointed for conversation=${args.conversationId} turn=${args.turnId}`,
        );
      }
      return persisted;
    },
    /** Prepare a cooperative yield at the current durable boundary. */
    prepareYieldIfDue(
      currentMessages: PiMessage[],
    ): CooperativeTurnYieldError | undefined {
      if (!args.durability.shouldYield?.()) {
        return undefined;
      }

      const nextResumeMessages = this.getResumeSnapshot(currentMessages);
      if (!isContinuablePiBoundary(nextResumeMessages)) {
        return undefined;
      }
      resumeMessages = nextResumeMessages;
      return new CooperativeTurnYieldError(
        `Agent turn yielded at a safe boundary after ${currentDurationMs()}ms`,
      );
    },
    /** Persist an auth pause; only a durable pause may return `awaiting_auth`. */
    async parkForAuth(
      pause: AuthorizationPauseError,
      currentUsage?: AgentTurnUsage,
    ): Promise<AuthPauseOutcome> {
      const usage =
        currentUsage ??
        (resumeMessages.length > 0
          ? extractSliceUsage(resumeMessages, beforeMessageCount)
          : undefined);
      try {
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistAuthPauseSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: resumeMessages,
          errorMessage: pause.message,
        });
        if (!sessionRecord) {
          throw new AuthPausePersistenceError(args.conversationId, args.turnId);
        }
        return {
          status: "awaiting_auth",
          providerDisplayName: pause.providerDisplayName,
          ...(pause.requestText ? { requestText: pause.requestText } : {}),
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        if (error instanceof AuthPausePersistenceError) {
          throw error;
        }
        throw new AuthPausePersistenceError(
          args.conversationId,
          args.turnId,
          error,
        );
      }
    },
    /** Persist a yield, retry, or timeout as a suspended run. */
    async translateSuspension(ending: {
      currentUsage?: AgentTurnUsage;
      error: unknown;
    }): Promise<AgentRunOutcome | undefined> {
      const { error } = ending;
      if (error instanceof CooperativeTurnYieldError) {
        const usage =
          ending.currentUsage ??
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
            `Failed to persist cooperative yield continuation for conversation=${args.conversationId} turn=${args.turnId}`,
          );
        }
        return {
          status: "suspended",
          resumeVersion: sessionRecord.version,
          ...(usage ? { usage } : {}),
        };
      }

      const resumeReason =
        error instanceof RetryableDeliveryError
          ? "retry"
          : timedOut
            ? "timeout"
            : undefined;
      if (resumeReason) {
        if (resumeReason === "retry") {
          // The failed assistant message was never saved. Regenerate it from
          // the latest saved agent history; an ambiguous provider write may
          // therefore produce a duplicate reply.
          resumeMessages = [...latestSafeBoundaryMessages];
        }
        const usage =
          ending.currentUsage ??
          extractSliceUsage(resumeMessages, beforeMessageCount);
        await args.recordActiveMcpProviders();
        const sessionRecord = await persistContinuationSessionRecord({
          ...sessionRecordBase(),
          currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: resumeMessages,
          errorMessage: error instanceof Error ? error.message : String(error),
          resumeReason,
        });
        if (!sessionRecord) {
          throw new Error(
            `Failed to persist continuation for conversation=${args.conversationId} turn=${args.turnId}`,
          );
        }
        if (sessionRecord.state === "awaiting_resume") {
          return {
            status: "suspended",
            resumeVersion: sessionRecord.version,
            ...(usage ? { usage } : {}),
          };
        }
        throw new TurnSliceLimitExceededError(botConfig.maxSlicesPerTurn);
      }

      return undefined;
    },
  };
}

export type ResumeState = ReturnType<typeof createResumeState>;
