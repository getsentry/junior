/**
 * In-memory resume helpers for one execution slice.
 *
 * Durable writes go through `saveTurnCheckpoint` only.
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
import type { Actor } from "@/chat/actor";
import {
  continuableMessages,
  saveTurnCheckpoint,
  type AgentTurnSurface,
  type TurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
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
  type AgentDurability,
} from "@/chat/agent/types";
import { TurnSliceLimitExceededError } from "@/chat/services/turn-limit";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";

interface ResumeStateArgs {
  channelName?: string;
  destination: Destination;
  destinationVisibility?: ConversationPrivacy;
  dispatchId?: string;
  durability: AgentDurability;
  recordActiveMcpProviders: () => Promise<void>;
  publishExternally: boolean;
  actor?: Actor;
  runSource: Source;
  conversationId: string;
  turnId: string;
  checkpoint: TurnCheckpoint;
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

/** Stable fingerprint of a parked boundary. */
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

/** Create resume state for one slice. */
export function createResumeState(args: ResumeStateArgs) {
  let beforeMessageCount = 0;
  let inputCommitted = false;
  let latestSafeBoundaryMessages: PiMessage[] = [];
  let timedOut = false;
  let resumeMessages: PiMessage[] = [];
  let turnContexts: PluginTurnContext[] = [];
  let turnStartMessageIndex: number | undefined;
  let advancedPastResume = !args.checkpoint.resumed;
  let resumedBoundaryKey = "";

  if (args.checkpoint.resumed && args.checkpoint.record.piMessages.length) {
    const prior = args.checkpoint.record;
    latestSafeBoundaryMessages = [...prior.piMessages];
    resumeMessages = [...prior.piMessages];
    resumedBoundaryKey = boundaryKey(
      continuableMessages(prior.piMessages, prior.piMessages),
    );
  }

  const currentSliceId = args.checkpoint.sliceId;
  const durationMs = () => Date.now() - args.startedAtMs;

  const writeBase = () => ({
    conversationId: args.conversationId,
    turnId: args.turnId,
    channelName: args.channelName,
    destination: args.destination,
    destinationVisibility: args.destinationVisibility,
    dispatchId: args.dispatchId,
    publishExternally: args.publishExternally,
    source: args.runSource,
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
    /** Use an already committed boundary as the resume baseline. */
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
      const saved = await saveTurnCheckpoint({
        mode: "running",
        ...writeBase(),
        sliceId: currentSliceId,
        messages,
        trailingMessageProvenance,
        turnContexts: turnContexts.length > 0 ? turnContexts : undefined,
        turnStartMessageIndex,
      });
      if (!saved) {
        return false;
      }
      latestSafeBoundaryMessages = [...messages];
      // Writing the same boundary does not count as progress.
      const persistedKey = boundaryKey(continuableMessages(messages, messages));
      if (
        resumedBoundaryKey.length === 0 ||
        persistedKey !== resumedBoundaryKey
      ) {
        advancedPastResume = true;
      }
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
    prepareYieldIfDue(
      currentMessages: PiMessage[],
    ): CooperativeTurnYieldError | undefined {
      if (!args.durability.shouldYield?.()) {
        return undefined;
      }
      const next = this.getResumeSnapshot(currentMessages);
      if (!isContinuablePiBoundary(next)) {
        return undefined;
      }
      resumeMessages = next;
      return new CooperativeTurnYieldError(
        `Agent turn yielded at a safe boundary after ${durationMs()}ms`,
      );
    },
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
        const record = await saveTurnCheckpoint({
          mode: "paused",
          reason: "auth",
          ...writeBase(),
          sliceId: currentSliceId,
          durationMs: durationMs(),
          usage,
          messages: resumeMessages,
          errorMessage: pause.message,
        });
        if (!record) {
          throw new AuthPausePersistenceError(args.conversationId, args.turnId);
        }
        return {
          status: "awaiting_auth",
          providerDisplayName: pause.providerDisplayName,
          ...(pause.requestText ? { requestText: pause.requestText } : {}),
          ...(usage ? { usage } : {}),
        };
      } catch (error) {
        if (
          error instanceof AuthPausePersistenceError ||
          error instanceof TurnSliceLimitExceededError
        ) {
          throw error;
        }
        throw new AuthPausePersistenceError(
          args.conversationId,
          args.turnId,
          error,
        );
      }
    },
    async translateSuspension(ending: {
      currentUsage?: AgentTurnUsage;
      error: unknown;
    }): Promise<AgentRunOutcome | undefined> {
      const { error } = ending;
      const reason =
        error instanceof CooperativeTurnYieldError
          ? "yield"
          : error instanceof RetryableDeliveryError
            ? "retry"
            : timedOut
              ? "timeout"
              : undefined;
      if (!reason) {
        return undefined;
      }

      if (reason === "retry") {
        // Failed assistant message was never saved; regenerate from last safe boundary.
        resumeMessages = [...latestSafeBoundaryMessages];
      }

      // Compare the boundary we would actually persist (after trim/fallback).
      const parkMessages =
        reason === "yield"
          ? [...resumeMessages]
          : continuableMessages(resumeMessages, latestSafeBoundaryMessages);
      const parkKey = boundaryKey(parkMessages);
      if (
        !advancedPastResume &&
        resumedBoundaryKey.length > 0 &&
        parkKey === resumedBoundaryKey
      ) {
        logWarn("agent.turn.no_progress_fail", {
          "app.ai.resume_conversation_id": args.conversationId,
          "app.ai.resume_session_id": args.turnId,
          "app.ai.resume_slice_id": currentSliceId,
          "app.ai.resume_reason": reason,
        });
        await saveTurnCheckpoint({
          mode: "failed",
          ...writeBase(),
          sliceId: currentSliceId,
          durationMs: durationMs(),
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
      const record = await saveTurnCheckpoint({
        mode: "paused",
        reason,
        ...writeBase(),
        sliceId: currentSliceId,
        durationMs: durationMs(),
        usage,
        messages: parkMessages,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      if (!record) {
        throw new Error(
          `Failed to persist continuation for conversation=${args.conversationId} turn=${args.turnId}`,
        );
      }
      if (record.state === "paused") {
        return {
          status: "suspended",
          resumeVersion: record.version,
          ...(usage ? { usage } : {}),
        };
      }
      throw new TurnSliceLimitExceededError(botConfig.maxSlicesPerTurn);
    },
  };
}

export type ResumeState = ReturnType<typeof createResumeState>;
