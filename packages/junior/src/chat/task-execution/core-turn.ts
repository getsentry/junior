/**
 * Turn steps that every work owner shares. A root Turn and a child agent
 * invocation give different inputs to the same steps. Only the run policy,
 * the history of a fork, and Delivery stay with each owner.
 */
import type { Actor, Destination, Source } from "@sentry/junior-plugin-api";
import {
  buildSteeringPiMessage,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import { botConfig } from "@/chat/config";
import {
  getPersistedSandboxState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { recordFinishedTurnForAutomatedLimit } from "@/chat/services/automated-turn-limit";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { maybePostAutomatedTurnLimitNotice } from "@/chat/slack/automated-turn-limit-notice";
import type { ThreadConversationState } from "@/chat/state/conversation";
import {
  getTurnRecord,
  saveTurnCheckpoint,
  type AgentTurnSurface,
} from "@/chat/task-execution/checkpoint";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

/** The sandbox of one Turn. Each change is saved on the Conversation. */
export interface TurnSandbox {
  /** The sandbox ref when the Turn started. */
  readonly initial: SandboxRef | undefined;
  /** The latest sandbox ref of the Turn. */
  readonly ref: SandboxRef | undefined;
  /** Save a new sandbox ref. Use it as `onSandboxRefChanged` of the Run. */
  onSandboxRefChanged(next: SandboxRef): Promise<void>;
}

/**
 * Read the saved sandbox ref of a Conversation and save each change. When the
 * owner keeps transcript state, `conversation` is saved with the ref.
 */
export function createTurnSandbox(args: {
  conversation?: ThreadConversationState;
  conversationId: string;
  persisted: Record<string, unknown>;
}): TurnSandbox {
  const initial = getPersistedSandboxState(args.persisted);
  let ref = initial;
  return {
    initial,
    get ref() {
      return ref;
    },
    onSandboxRefChanged: async (next) => {
      ref = next;
      await persistThreadStateById(args.conversationId, {
        ...(args.conversation
          ? { conversation: args.conversation }
          : undefined),
        sandboxRef: ref,
      });
    },
  };
}

/**
 * Count one finished Turn toward the automated-turn limit, or reset the count
 * when the Turn answers its owner. A root's owner is a person. A child's
 * owner is its parent agent. Post the pause notice when the limit is full.
 */
export async function recordAutomatedTurnLimit(args: {
  conversationId: string;
  /** True when the input came from the owner of the Conversation. */
  ownerInput?: boolean;
  source: Source;
}): Promise<void> {
  const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
  const update = await recordFinishedTurnForAutomatedLimit({
    conversationId: args.conversationId,
    maxTurns,
    // An owner input resets the count like a person's message.
    source: args.ownerInput ? undefined : args.source,
  });
  // A Conversation without a Slack Location skips the notice and clears its
  // claim.
  await maybePostAutomatedTurnLimitNotice({
    conversationId: args.conversationId,
    maxTurns,
    source: args.source,
    update,
  });
}

/**
 * Save a finished Run on its Conversation: the sandbox ref, the completed
 * Turn checkpoint, and the automated-turn limit. `conversation` is the
 * transcript state to save, when the owner keeps one.
 */
export async function saveFinishedTurn(args: {
  actor: Actor;
  conversation?: ThreadConversationState;
  conversationId: string;
  destination?: Destination;
  ownerInput?: boolean;
  result: AgentRunResult;
  sandbox: TurnSandbox;
  source: Source;
  surface: AgentTurnSurface;
  turnId: string;
}): Promise<void> {
  const { result } = args;
  await persistThreadStateById(args.conversationId, {
    ...(args.conversation ? { conversation: args.conversation } : undefined),
    sandboxRef: result.sandboxRef ?? args.sandbox.ref,
  });
  if (result.piMessages?.length) {
    // Continue the slice of the latest checkpoint after a yield or resume. A
    // Turn with no checkpoint yet starts at slice 1.
    const latest = await getTurnRecord(args.conversationId, args.turnId);
    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: args.conversationId,
      turnId: args.turnId,
      sliceId: latest?.sliceId ?? 1,
      messages: result.piMessages,
      durationMs: result.diagnostics.durationMs,
      usage: result.diagnostics.usage,
      ...(result.diagnostics.outcome !== "success"
        ? { errorMessage: result.diagnostics.errorMessage ?? "Turn failed" }
        : undefined),
      // TODO(dcramer): Remove checkpoint Destination after resume reads the
      // Conversation Location.
      destination: args.destination,
      source: args.source,
      actor: args.actor,
      surface: args.surface,
    });
  }
  await recordAutomatedTurnLimit({
    conversationId: args.conversationId,
    ownerInput: args.ownerInput,
    source: args.source,
  });
}

/**
 * Give pending mailbox input to the running Turn as steering messages.
 * `select` picks the input that joins, and the mailbox ids to mark read. The
 * first input that cannot join must stop the scan, so later input waits too.
 * A message that a failed earlier drain already saved in the Turn does not
 * join again.
 */
export function createSteeringDrain<T>(args: {
  context: ConversationWorkerContext;
  /** Drain deferred input too, such as messages from a parent agent. */
  deferred?: boolean;
  select(pending: InboundMessage[]): Promise<{
    joining: T[];
    readIds: string[];
  }>;
  /** Save the joining input before the Turn reads it. */
  beforeAccept?(joining: T[]): Promise<void>;
  /** Mark the joining input after the Turn saved it. */
  afterAccept?(joining: T[]): Promise<void>;
  toSteeringMessage(item: T): AgentSteeringMessage;
  turnId: string;
}) {
  const { context } = args;
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(
      async (pending) => {
        const { joining, readIds } = await args.select(pending);
        if (joining.length === 0) {
          return readIds;
        }
        await args.beforeAccept?.(joining);
        const saved =
          (await getTurnRecord(context.conversationId, args.turnId))
            ?.piMessages ?? [];
        const messages = withoutSavedSteeringMessages(
          saved,
          joining.map(args.toSteeringMessage),
          buildSteeringPiMessage,
        );
        if (messages.length > 0) {
          await accept(messages);
          accepted.push(...messages);
        }
        await args.afterAccept?.(joining);
        return readIds;
      },
      args.deferred ? { deferred: true } : undefined,
    );
    return accepted;
  };
}
