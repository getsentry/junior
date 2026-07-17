/**
 * Conversation projection orchestration.
 *
 * Materializes model-visible Pi context and derived run facts such as connected
 * providers. Storage and commit lifecycle stay in the conversations domain;
 * the Pi adapter owns event reduction and opaque-message validation.
 */
import { isDeepStrictEqual } from "node:util";
import type { PiMessage } from "@/chat/pi/messages";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import type {
  AuthorizationKind,
  ConversationEvent,
} from "@/chat/conversations/history";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import type { JuniorSqlDatabase } from "@/db/db";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import {
  projectConversationEvents,
  type PiConversationEventProjection,
  type PiConversationProjection,
} from "@/chat/pi/conversation-events";

/** Distinct MCP providers durably connected in the given events, sorted. */
function connectedMcpProvidersFromEvents(
  events: ConversationEvent[],
): string[] {
  const providers = new Set<string>();
  for (const event of events) {
    if (event.data.type === "mcp_provider_connected") {
      providers.add(event.data.provider);
    }
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

function isUserMessage(message: PiMessage): boolean {
  return (message as { role?: unknown }).role === "user";
}

function countMatchingPrefix(left: PiMessage[], right: PiMessage[]): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (!isDeepStrictEqual(left[index], right[index])) {
      return index;
    }
  }
  return limit;
}

/**
 * Resolve the aligned provenance to persist for `nextMessages`.
 *
 * Explicit per-message provenance always wins; otherwise the unchanged prefix
 * reuses its committed provenance, new messages default to unauthored context,
 * and any new-user-message default (the turn author's instruction) attaches to
 * the last new user message — the current turn's input.
 */
function resolveCommitProvenance(args: {
  existing: Pick<PiConversationProjection, "messages" | "provenance">;
  nextMessages: PiMessage[];
  matchingPrefix: number;
  explicitProvenance?: ConversationMessageProvenance[];
  trailingMessageProvenance?: ConversationMessageProvenance[];
  newMessageProvenance?: ConversationMessageProvenance;
}): ConversationMessageProvenance[] {
  if (args.explicitProvenance) {
    if (args.explicitProvenance.length !== args.nextMessages.length) {
      throw new Error("commit provenance must align one-to-one with messages");
    }
    return args.explicitProvenance;
  }
  const matchingPrefix = args.matchingPrefix;
  const provenance = args.nextMessages.map((_, index) =>
    index < matchingPrefix
      ? (args.existing.provenance[index] ?? contextProvenance)
      : contextProvenance,
  );
  if (args.newMessageProvenance) {
    for (
      let index = args.nextMessages.length - 1;
      index >= matchingPrefix;
      index -= 1
    ) {
      if (isUserMessage(args.nextMessages[index]!)) {
        provenance[index] = args.newMessageProvenance;
        break;
      }
    }
  }
  if (args.trailingMessageProvenance) {
    if (args.trailingMessageProvenance.length > provenance.length) {
      throw new Error(
        "trailing commit provenance cannot exceed committed messages",
      );
    }
    const newMessageCount = args.nextMessages.length - matchingPrefix;
    if (args.trailingMessageProvenance.length > newMessageCount) {
      throw new Error(
        "trailing commit provenance must align to newly committed messages",
      );
    }
    const start = provenance.length - args.trailingMessageProvenance.length;
    args.trailingMessageProvenance.forEach((entry, offset) => {
      provenance[start + offset] = entry;
    });
  }
  return provenance;
}

interface ScopedConversation {
  conversationId: string;
}

/** Load the current-epoch Pi projection for a conversation. */
export async function loadProjection(
  args: ScopedConversation,
): Promise<PiMessage[]> {
  const events = await getConversationEventStore().loadCurrentEpoch(
    args.conversationId,
  );
  return projectConversationEvents(events).messages;
}

/** Load the current-epoch Pi projection with aligned per-message provenance. */
export async function loadConversationProjection(
  args: ScopedConversation,
): Promise<PiConversationProjection> {
  const events = await getConversationEventStore().loadCurrentEpoch(
    args.conversationId,
  );
  return projectConversationEvents(events);
}

/** Open a standard initial epoch before a conversation's first model request. */
export async function openConversationProjection(
  args: ScopedConversation & { modelId: string },
): Promise<PiConversationProjection> {
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentEpoch(args.conversationId);
  const projection = projectConversationEvents(events);
  if (events.some((event) => event.data.type === "context_epoch_started")) {
    return projection;
  }
  // Host facts may predate the first model request. Keep them in epoch 0 and
  // make that formerly implicit epoch explicit before model execution.
  await eventStore.startEpoch(args.conversationId, {
    reason: "initial",
    modelProfile: "standard",
    modelId: args.modelId,
    messages: [],
  });
  return {
    messages: projection.messages,
    provenance: projection.provenance,
    modelProfile: "standard",
    modelId: args.modelId,
  };
}

/**
 * Load a turn's committed Pi projection from the durable event store.
 *
 * The record stays pinned to the epoch containing its committed boundary, so a
 * later rollback or compaction cannot silently rewrite what a stale record
 * resumes from. Unfinished records (`includeTail`) also see that epoch's tail
 * so parked input appended after the last safe boundary is model-visible; for
 * a live run the committed epoch is the current epoch. Terminal records
 * reproduce exactly the boundary they committed by cutting at `committedSeq`.
 * Returns undefined when the committed boundary no longer exists (purged
 * history) so callers fail closed.
 */
export async function loadTurnProjection(args: {
  conversationId: string;
  committedSeq: number;
  includeTail: boolean;
}): Promise<PiConversationEventProjection | undefined> {
  const eventStore = getConversationEventStore();
  // A record that committed no messages materializes the live projection, the
  // same way count-based records with a zero cursor did.
  if (args.committedSeq < 0) {
    return projectConversationEvents(
      await eventStore.loadCurrentEpoch(args.conversationId),
    );
  }
  const epochEvents = await eventStore.loadEpochContaining(
    args.conversationId,
    args.committedSeq,
    args.includeTail ? undefined : args.committedSeq,
  );
  if (!epochEvents) {
    return undefined;
  }
  return projectConversationEvents(epochEvents);
}

/** Load MCP providers durably connected in this conversation's current epoch. */
export async function loadConnectedMcpProviders(
  args: ScopedConversation,
): Promise<string[]> {
  const events = await getConversationEventStore().loadCurrentEpoch(
    args.conversationId,
  );
  return connectedMcpProvidersFromEvents(events);
}

function messageTimestamp(message: PiMessage): number {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

/**
 * Commit the turn's Pi history: append when it advanced the committed
 * projection normally, or open a `rollback` epoch when it diverged (a
 * provider-retry trim regenerated trailing assistant output). Returns the
 * resolved provenance, the per-message event seqs, and the `seq` boundary that
 * reproduces exactly the committed messages. A first commit atomically opens
 * the standard initial epoch; the run boundary opens it earlier when a model
 * may act before any session checkpoint, such as recordless handoff.
 */
export async function commitMessages(args: {
  conversationId: string;
  /** Exact model selected for this write; persisted for epoch audit only. */
  modelId: string;
  messages: PiMessage[];
  /** Explicit per-message provenance aligned one-to-one with `messages`. */
  provenance?: ConversationMessageProvenance[];
  /** Explicit provenance for the trailing newly committed messages. */
  trailingMessageProvenance?: ConversationMessageProvenance[];
  /** Default applied to the last new user message when no explicit array. */
  newMessageProvenance?: ConversationMessageProvenance;
  /** SQL authority for the atomic commit; defaults to the process executor. */
  executor?: JuniorSqlDatabase;
}): Promise<{
  committedSeq: number;
  /** Event sequence for every projected model message. */
  messageSeqs: number[];
  provenance: ConversationMessageProvenance[];
}> {
  const executor = args.executor ?? getSqlExecutor();
  return await withConversationEventLock(
    executor,
    args.conversationId,
    async () =>
      executor.transaction(
        async () => await commitMessagesLocked(args, executor),
      ),
  );
}

async function commitMessagesLocked(
  args: Parameters<typeof commitMessages>[0],
  executor: JuniorSqlDatabase,
): ReturnType<typeof commitMessages> {
  const eventStore = createSqlConversationEventStore(executor);
  const currentEvents = await eventStore.loadCurrentEpoch(args.conversationId);
  const current = projectConversationEvents(currentEvents);
  const nextLocalMessages = args.messages;
  const matchingPrefix = countMatchingPrefix(
    current.messages,
    nextLocalMessages,
  );
  const nextLocalProvenance = resolveCommitProvenance({
    existing: current,
    nextMessages: nextLocalMessages,
    matchingPrefix,
    ...(args.provenance ? { explicitProvenance: args.provenance } : {}),
    ...(args.trailingMessageProvenance
      ? { trailingMessageProvenance: args.trailingMessageProvenance }
      : {}),
    ...(args.newMessageProvenance
      ? { newMessageProvenance: args.newMessageProvenance }
      : {}),
  });
  const hasContextEpochMarker = currentEvents.some(
    (event) => event.data.type === "context_epoch_started",
  );
  if (
    currentEvents.length === 0 ||
    (!hasContextEpochMarker && matchingPrefix === current.messages.length)
  ) {
    const initialMessages = nextLocalMessages.slice(matchingPrefix);
    await eventStore.startEpoch(args.conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: args.modelId,
      messages: initialMessages.map((message, index) => ({
        message,
        createdAtMs: messageTimestamp(message),
        provenance: nextLocalProvenance[matchingPrefix + index]!,
      })),
    });
  } else if (matchingPrefix === current.messages.length) {
    const newMessages = nextLocalMessages.slice(matchingPrefix);
    await eventStore.append(
      args.conversationId,
      newMessages.map((message, index) => ({
        data: {
          type: "message" as const,
          message,
          provenance: nextLocalProvenance[matchingPrefix + index]!,
        },
        createdAtMs: messageTimestamp(message),
      })),
    );
  } else {
    await eventStore.startEpoch(args.conversationId, {
      reason: "rollback",
      modelProfile: current.modelProfile,
      modelId: args.modelId,
      messages: nextLocalMessages.map((message, index) => ({
        message,
        createdAtMs: messageTimestamp(message),
        provenance: nextLocalProvenance[index]!,
      })),
    });
  }
  const committed = projectConversationEvents(
    await eventStore.loadCurrentEpoch(args.conversationId),
  );
  return {
    committedSeq: committed.seqs.at(-1) ?? -1,
    messageSeqs: committed.seqs,
    provenance: nextLocalProvenance,
  };
}

/** Record a successful MCP provider connection without duplicating the fact. */
export async function recordMcpProviderConnected(args: {
  conversationId: string;
  provider: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentEpoch(args.conversationId);
  if (connectedMcpProvidersFromEvents(events).includes(args.provider)) {
    return;
  }
  await eventStore.append(args.conversationId, [
    {
      data: { type: "mcp_provider_connected", provider: args.provider },
      createdAtMs: Date.now(),
    },
  ]);
}

/** Record that an OAuth/MCP authorization link was delivered or reused. */
export async function recordAuthorizationRequested(args: {
  conversationId: string;
  kind: AuthorizationKind;
  provider: string;
  actorId: string;
  authorizationId: string;
  delivery: "private_link_sent" | "private_link_reused";
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentEpoch(args.conversationId);
  if (
    events.some(
      (event) =>
        event.data.type === "authorization_requested" &&
        event.data.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await eventStore.append(args.conversationId, [
    {
      data: {
        type: "authorization_requested",
        kind: args.kind,
        provider: args.provider,
        actorId: args.actorId,
        authorizationId: args.authorizationId,
        delivery: args.delivery,
      },
      createdAtMs: Date.now(),
    },
  ]);
}

/** Record completed authorization as a chronological host observation for Pi. */
export async function recordAuthorizationCompleted(args: {
  conversationId: string;
  kind: AuthorizationKind;
  provider: string;
  actorId: string;
  authorizationId: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentEpoch(args.conversationId);
  if (
    events.some(
      (event) =>
        event.data.type === "authorization_completed" &&
        event.data.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await eventStore.append(args.conversationId, [
    {
      data: {
        type: "authorization_completed",
        kind: args.kind,
        provider: args.provider,
        actorId: args.actorId,
        authorizationId: args.authorizationId,
      },
      createdAtMs: Date.now(),
    },
  ]);
}

/** Record a host-observed parent tool start without adding it to Pi replay. */
export async function recordToolExecutionStarted(args: {
  conversationId: string;
  createdAtMs?: number;
  toolCallId: string;
  toolName: string;
}): Promise<void> {
  await getConversationEventStore().append(args.conversationId, [
    {
      data: {
        type: "tool_execution_started",
        toolCallId: args.toolCallId,
        toolName: args.toolName,
      },
      createdAtMs: args.createdAtMs ?? Date.now(),
    },
  ]);
}
