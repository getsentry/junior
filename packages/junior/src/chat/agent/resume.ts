/**
 * Run resumability.
 *
 * Keeps the in-memory baseline for one slice and translates stop reasons into
 * durable checkpoints:
 * - running checkpoint after each safe tool boundary
 * - paused checkpoint for auth / timeout / yield / retry
 *
 * One write API: `saveTurnCheckpoint`.
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
  saveTurnCheckpoint,
} from "@/chat/services/turn-session-record";
import {
  AuthPausePersistenceError,
  type AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { extractGenAiUsageSummary, logWarn } from "@/chat/logging";
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
  getLoadedSkillNames: () => string[];
  getModelId: () => string;
  getReasoningLevel: () => string | undefined;
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

/** Fingerprint a boundary so identical parks can be detected. */
function boundaryKey(messages: PiMessage[]): string {
  return messages
    .map((message) => {
      const record = message as {
        role?: unknown;
        timestamp?: unknown;
        toolCallId?: unknown;
        content?: unknown;
      };
      const content =
        typeof record.content === "string"
          ? record.content
          : JSON.stringify(record.content ?? null);
      return [
        String(record.role ?? ""),
        String(record.timestamp ?? ""),
        String(record.toolCallId ?? ""),
        content,
      ].join("\u0001");
    })
    .join("\u0002");
}

/** Create the run's resume state: checkpoints, snapshots, and ending translation. */
export function createResumeState(args: ResumeStateArgs) {
  let beforeMessageCount = 0;
  let inputCommitted = false;
  let latestSafeBoundaryMessages: PiMessage[] = [];
  let latestSafeBoundaryKey = "";
  let timedOut = false;
  let resumeMessages: PiMessage[] = [];
  let turnContexts: PluginTurnContext[] = [];
  let turnStartMessageIndex: number | undefined;
  // Only fail closed when we resume from a parked boundary and park there
  // again without a newer running checkpoint in this slice.
  let resumedBoundaryKey = "";
  let advancedPastResume = !args.sessionRecordState.resumedFromSessionRecord;
  const prior = args.sessionRecordState.existingSessionRecord;
  if (
    args.sessionRecordState.resumedFromSessionRecord &&
    prior?.piMessages?.length
  ) {
    latestSafeBoundaryMessages = [...prior.piMessages];
    latestSafeBoundaryKey = boundaryKey(prior.piMessages);
    resumedBoundaryKey = latestSafeBoundaryKey;
  }

  const currentSliceId = args.sessionRecordState.currentSliceId;
  const currentDurationMs = () => Date.now() - args.startedAtMs;

  const baseFields = () => ({
    channelName: args.channelName,
    conversationId: args.conversationId,
    destination: args.destination,
    ...(args.destinationVisibility
      ? { destinationVisibility: args.destinationVisibility }
      : {}),
    ...(args.dispatchId ? { dispatchId: args.dispatchId } : {}),
    source: args.runSource,
    sessionId: args.turnId,
    loadedSkillNames: args.getLoadedSkillNames(),
    modelId: args.getModelId(),
    ...(args.getReasoningLevel()
      ? { reasoningLevel: args.getReasoningLevel() }
      : {}),
    actor: args.actor,
    surface: args.surface,
  });

  const rememberBoundary = (messages: PiMessage[]): void => {
    latestSafeBoundaryMessages = [...messages];
    latestSafeBoundaryKey = boundaryKey(messages);
  };

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
    /** Adopt an already committed boundary as every resume baseline. */
    adoptCommittedBoundary(messages: PiMessage[]): void {
      rememberBoundary(messages);
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
      const saved = await saveTurnCheckpoint({
        mode: "running",
        ...baseFields(),
        sliceId: currentSliceId,
        messages,
        ...(trailingMessageProvenance ? { trailingMessageProvenance } : {}),
        ...(turnContexts.length > 0 ? { turnContexts } : {}),
        ...(turnStartMessageIndex !== undefined
          ? { turnStartMessageIndex }
          : {}),
      });
      if (!saved) {
        return false;
      }
      rememberBoundary(messages);
      advancedPastResume = true;
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
        const sessionRecord = await saveTurnCheckpoint({
          mode: "paused",
          reason: "auth",
          ...baseFields(),
          sliceId: currentSliceId,
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
        const sessionRecord = await saveTurnCheckpoint({
          mode: "paused",
          reason: "yield",
          keepSlice: true,
          ...baseFields(),
          sliceId: currentSliceId,
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

        const parkMessages = [...resumeMessages];
        const parkKey = boundaryKey(parkMessages);
        const stuckAtResumedBoundary =
          !advancedPastResume &&
          resumedBoundaryKey.length > 0 &&
          parkKey === resumedBoundaryKey;

        if (stuckAtResumedBoundary) {
          logWarn("agent.turn.no_progress_fail", {
            "app.ai.resume_conversation_id": args.conversationId,
            "app.ai.resume_session_id": args.turnId,
            "app.ai.resume_slice_id": currentSliceId,
            "app.ai.resume_reason": resumeReason,
          });
          await saveTurnCheckpoint({
            mode: "failed",
            ...baseFields(),
            sliceId: currentSliceId,
            currentDurationMs: currentDurationMs(),
            messages: parkMessages,
            errorMessage:
              "Turn made no progress: continue parked at the same boundary",
          });
          throw new Error(
            `Turn made no progress for conversation=${args.conversationId} turn=${args.turnId}`,
          );
        }

        const usage =
          ending.currentUsage ??
          extractSliceUsage(parkMessages, beforeMessageCount);
        await args.recordActiveMcpProviders();
        const sessionRecord = await saveTurnCheckpoint({
          mode: "paused",
          reason: resumeReason,
          ...baseFields(),
          sliceId: currentSliceId,
          currentDurationMs: currentDurationMs(),
          currentUsage: usage,
          messages: parkMessages,
          errorMessage: error instanceof Error ? error.message : String(error),
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
