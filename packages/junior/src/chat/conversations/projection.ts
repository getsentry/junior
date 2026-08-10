/**
 * Conversation projection orchestration.
 *
 * Materializes Pi agent history and derived run facts such as connected
 * providers. Storage and commit lifecycle stay in the conversations domain;
 * the Pi adapter owns event reduction and opaque-message validation.
 */
import { isDeepStrictEqual } from "node:util";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import type {
  AuthorizationKind,
  ConversationEvent,
} from "@/chat/conversations/history";
import type { RepositoryInstructions } from "@/chat/repository-instructions";
import {
  agentsInstructionsUpdatedEvent,
  authenticationLinkedEvent,
  authenticationUnlinkedEvent,
  JUNIOR_NATIVE_EVENT_NAMESPACE,
} from "@/chat/conversations/structured-events";
import { getConversationEventStore, getSqlExecutor } from "@/chat/db";
import type { JuniorSqlDatabase } from "@/db/db";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import {
  bindProviderConversation,
  type ProviderConversationBinding,
} from "@/chat/conversations/sql/bindings";
import { withConversationEventLock } from "@/chat/conversations/sql/event-lock";
import {
  historyItemFromPiMessage,
  projectConversationEvents,
  type PiConversationEventProjection,
  type PiConversationProjection,
} from "@/chat/pi/conversation-events";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import { sanitizePostgresJson } from "@/db/postgres-json";
import type { ModelProfile } from "@/chat/model-profile";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import type { ThreadConversationState } from "@/chat/state/conversation";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { appendConversationMessages } from "./messages";

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

/** A checkpoint tried to replace already committed agent history. */
export class AgentHistoryBranchError extends Error {
  constructor(conversationId: string) {
    super(
      `Agent history for ${conversationId} changed before its committed boundary`,
    );
    this.name = "AgentHistoryBranchError";
  }
}

/** Match the exact JSONB shape used for prefix comparison and replay. */
function normalizeDurableMessage(message: PiMessage): PiMessage {
  return piMessageSchema.parse(
    JSON.parse(JSON.stringify(sanitizePostgresJson(message))),
  );
}

/**
 * Identity used for append-only prefix checks.
 *
 * Pi may mutate already-committed assistant envelopes in place (usage,
 * stopReason, provider metadata). Append checkpoints must still accept the
 * new suffix when role, timestamp, and durable content match.
 */
function durableMessageIdentity(message: PiMessage): unknown {
  const record = message as {
    role?: unknown;
    timestamp?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
  if (record.role === "toolResult") {
    return {
      role: "toolResult",
      timestamp: record.timestamp,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      isError: record.isError,
      content: record.content,
    };
  }
  return {
    role: record.role,
    timestamp: record.timestamp,
    content: record.content,
  };
}

/**
 * Count how much of `current` is a durable prefix of `next`.
 *
 * Returns `current.length` only when every committed message still matches by
 * durable identity. A shorter `next` or a content/role/timestamp change is a
 * branch that only compaction/handoff may perform.
 */
function countDurablePrefix(current: PiMessage[], next: PiMessage[]): number {
  if (next.length < current.length) {
    return countMatchingDeepPrefix(current, next);
  }
  for (let index = 0; index < current.length; index += 1) {
    if (
      !isDeepStrictEqual(
        durableMessageIdentity(current[index]!),
        durableMessageIdentity(next[index]!),
      )
    ) {
      return index;
    }
  }
  return current.length;
}

function countMatchingDeepPrefix(
  left: PiMessage[],
  right: PiMessage[],
): number {
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
  if (args.existing.provenance.length !== args.existing.messages.length) {
    throw new Error("committed provenance must align one-to-one with messages");
  }
  const matchingPrefix = args.matchingPrefix;
  const provenance = args.nextMessages.map((_, index) =>
    index < matchingPrefix
      ? args.existing.provenance[index]!
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

/** Load the current Pi agent history for a conversation. */
export async function loadProjection(
  args: ScopedConversation,
): Promise<PiMessage[]> {
  const events = await getConversationEventStore().loadCurrentHistory(
    args.conversationId,
  );
  return projectConversationEvents(events).messages;
}

/** Load current Pi context with aligned provenance and source event sequences. */
export async function loadConversationProjection(
  args: ScopedConversation,
): Promise<PiConversationEventProjection> {
  const events = await getConversationEventStore().loadCurrentHistory(
    args.conversationId,
  );
  return projectConversationEvents(events);
}

/** Load the active Pi projection before a conversation's next request. */
export async function openConversationProjection(
  args: ScopedConversation,
): Promise<PiConversationProjection> {
  const events = await getConversationEventStore().loadCurrentHistory(
    args.conversationId,
  );
  return projectConversationEvents(events);
}

/**
 * Load a turn's committed Pi projection from the durable event store.
 *
 * The record stays pinned to the history version containing its committed
 * boundary, so later compaction cannot rewrite what a stale record resumes
 * from. Unfinished records (`includeTail`) also see that version's tail so
 * parked input appended after the last safe boundary is model-visible. Terminal records
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
      await eventStore.loadCurrentHistory(args.conversationId),
    );
  }
  const historyEvents = await eventStore.loadHistoryContaining(
    args.conversationId,
    args.committedSeq,
    args.includeTail ? undefined : args.committedSeq,
  );
  if (!historyEvents) {
    return undefined;
  }
  return projectConversationEvents(historyEvents);
}

/** Load MCP providers connected in the current agent-history version. */
export async function loadConnectedMcpProviders(
  args: ScopedConversation,
): Promise<string[]> {
  const events = await getConversationEventStore().loadCurrentHistory(
    args.conversationId,
  );
  return connectedMcpProvidersFromEvents(events);
}

function messageTimestamp(message: PiMessage): number {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

/**
 * Append newly stable native history items.
 *
 * Checkpoints are append-only against the durable identity of the committed
 * prefix (role, timestamp, content; tool results also match call id). A shorter
 * history or a true content branch is rejected — only compaction and handoff may
 * intentionally replace active model history. In-place Pi mutations of already
 * committed assistant envelopes (usage/stopReason) do not block the suffix.
 */
export async function commitMessages(args: {
  conversationId: string;
  messages: PiMessage[];
  /** Explicit per-message provenance aligned one-to-one with `messages`. */
  provenance?: ConversationMessageProvenance[];
  /** Explicit provenance for the trailing newly committed messages. */
  trailingMessageProvenance?: ConversationMessageProvenance[];
  /** Default applied to the last new user message when no explicit array. */
  newMessageProvenance?: ConversationMessageProvenance;
  /** Structured plugin context committed atomically with this turn's input. */
  turnContext?: {
    contexts: PluginTurnContext[];
    turnId: string;
  };
  /** SQL authority for the atomic commit; defaults to the process executor. */
  executor?: JuniorSqlDatabase;
}): Promise<{
  committedSeq: number;
  historyVersion: number;
  /** Event sequence for every projected agent history item. */
  messageSeqs: number[];
  /** Normalized durable messages after volatile runtime context is removed. */
  messages: PiMessage[];
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

/**
 * Commit an accepted agent reply and its visible message in causal order.
 *
 * The destination has already accepted the reply. One transaction prevents
 * reporting from observing the visible reply before the agent message that
 * produced it.
 */
export async function commitAcceptedReply(args: {
  agentMessage?: AssistantMessage;
  conversation: ThreadConversationState;
  conversationMessageId: string;
  conversationId: string;
  providerConversationBindings?: Array<
    Omit<ProviderConversationBinding, "conversationId">
  >;
  repliedAtMs?: number;
}): Promise<void> {
  const executor = getSqlExecutor();
  await withConversationEventLock(executor, args.conversationId, async () =>
    executor.transaction(async () => {
      if (args.agentMessage) {
        const agentMessage = normalizeDurableMessage(args.agentMessage);
        await createSqlConversationEventStore(executor).append(
          args.conversationId,
          [
            {
              idempotencyKey: `message:${args.conversationMessageId}:agent`,
              data: historyItemFromPiMessage(agentMessage, contextProvenance),
              createdAtMs: messageTimestamp(agentMessage),
            },
          ],
        );
      }
      await appendConversationMessages(
        createSqlConversationEventStore(executor),
        {
          conversation: args.conversation,
          conversationId: args.conversationId,
          ...(args.repliedAtMs === undefined
            ? {}
            : { repliedAtMs: args.repliedAtMs }),
        },
      );
      for (const binding of args.providerConversationBindings ?? []) {
        await bindProviderConversation(executor, {
          conversationId: args.conversationId,
          ...binding,
        });
      }
    }),
  );
}

async function commitMessagesLocked(
  args: Parameters<typeof commitMessages>[0],
  executor: JuniorSqlDatabase,
): ReturnType<typeof commitMessages> {
  const eventStore = createSqlConversationEventStore(executor);
  const currentEvents = await eventStore.loadCurrentHistory(
    args.conversationId,
  );
  const current = projectConversationEvents(currentEvents);
  // Runtime bootstrap is per-run input, not durable agent history. Session
  // records may retain it while a turn is live, but event replay must not need
  // a compensating history rewrite when that bootstrap changes.
  const nextLocalMessages = stripRuntimeTurnContext(args.messages).map(
    normalizeDurableMessage,
  );
  const matchingPrefix = countDurablePrefix(
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
  if (matchingPrefix === current.messages.length) {
    const newMessages = nextLocalMessages.slice(matchingPrefix);
    const turnContext = args.turnContext;
    const turnContextEvents =
      turnContext?.contexts.map((context, index) => ({
        idempotencyKey:
          `turn:${turnContext.turnId}:context:` +
          `${context.pluginName}:${index}`,
        createdAtMs: context.loadedAtMs,
        data: {
          type: "turn_context" as const,
          turnId: turnContext.turnId,
          pluginName: context.pluginName,
          kind: context.kind,
          version: context.version,
          content: context.content,
        },
      })) ?? [];
    await eventStore.append(args.conversationId, [
      ...newMessages.map((message, index) => ({
        data: historyItemFromPiMessage(
          message,
          nextLocalProvenance[matchingPrefix + index]!,
        ),
        createdAtMs: messageTimestamp(message),
      })),
      ...turnContextEvents,
    ]);
  } else {
    throw new AgentHistoryBranchError(args.conversationId);
  }
  const committedEvents = await eventStore.loadCurrentHistory(
    args.conversationId,
  );
  const committed = projectConversationEvents(committedEvents);
  return {
    committedSeq: committedEvents.at(-1)?.seq ?? -1,
    historyVersion: committedEvents.at(-1)?.historyVersion ?? 0,
    messageSeqs: committed.seqs,
    messages: nextLocalMessages,
    provenance: nextLocalProvenance,
  };
}

/** Record a successful MCP provider connection without duplicating the fact. */
export async function recordMcpProviderConnected(args: {
  conversationId: string;
  provider: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const events = await eventStore.loadCurrentHistory(args.conversationId);
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
  const events = await eventStore.loadCurrentHistory(args.conversationId);
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
  const events = await eventStore.loadCurrentHistory(args.conversationId);
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

type AuthenticationAccountChangeArgs = {
  accountLabel?: string;
  actorId: string;
  authorizationId?: string;
  conversationId: string;
  provider: string;
  providerLabel?: string;
  turnId?: string;
};

function authenticationEventIdempotencyKey(args: {
  action: "linked" | "unlinked";
  actorId: string;
  authorizationId?: string;
  provider: string;
}): string {
  if (args.authorizationId) {
    return `native:${JUNIOR_NATIVE_EVENT_NAMESPACE}:authentication_${args.action}:authorization:${args.authorizationId}`;
  }
  return (
    `native:${JUNIOR_NATIVE_EVENT_NAMESPACE}:authentication_${args.action}:` +
    `${args.provider}:actor:${args.actorId}`
  );
}

async function recordAuthenticationAccountChange(
  action: "linked" | "unlinked",
  args: AuthenticationAccountChangeArgs,
): Promise<void> {
  const definition =
    action === "linked"
      ? authenticationLinkedEvent
      : authenticationUnlinkedEvent;
  const content = definition.parse({
    actorId: args.actorId,
    provider: args.provider,
    ...(args.accountLabel ? { accountLabel: args.accountLabel } : {}),
    ...(args.authorizationId ? { authorizationId: args.authorizationId } : {}),
    ...(args.providerLabel ? { providerLabel: args.providerLabel } : {}),
  });
  await getConversationEventStore().append(args.conversationId, [
    {
      createdAtMs: Date.now(),
      idempotencyKey: authenticationEventIdempotencyKey({
        action,
        actorId: args.actorId,
        authorizationId: args.authorizationId,
        provider: args.provider,
      }),
      data: {
        type: "structured_event",
        namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
        name: definition.eventName,
        version: definition.version,
        ...(args.turnId ? { turnId: args.turnId } : {}),
        content,
      },
    },
  ]);
}

/** Record a successful conversation-bound account link as host transcript metadata. */
export async function recordAuthenticationLinked(
  args: AuthenticationAccountChangeArgs,
): Promise<void> {
  await recordAuthenticationAccountChange("linked", args);
}

/** Record a successful conversation-bound account unlink as host transcript metadata. */
export async function recordAuthenticationUnlinked(
  args: AuthenticationAccountChangeArgs,
): Promise<void> {
  await recordAuthenticationAccountChange("unlinked", args);
}

type AgentsInstructionsTransitionArgs = {
  conversationId: string;
  instructions?: RepositoryInstructions;
  turnId: string;
};

type AgentsEventContent = {
  action: "loaded" | "replaced" | "cleared";
  directory?: string;
  fingerprint: string;
};

async function loadAgentsEvent(conversationId: string): Promise<
  | {
      content: AgentsEventContent;
      seq: number;
    }
  | undefined
> {
  const event = await getConversationEventStore().loadLatestStructuredEvent(
    conversationId,
    JUNIOR_NATIVE_EVENT_NAMESPACE,
    agentsInstructionsUpdatedEvent.eventName,
  );
  if (!event || event.data.type !== "structured_event") return undefined;
  return {
    content: agentsInstructionsUpdatedEvent.parse(
      event.data.content,
    ) as AgentsEventContent,
    seq: event.seq,
  };
}

function agentsInstructionsIdempotencyKey(args: {
  action: "loaded" | "replaced" | "cleared";
  fingerprint: string;
  previousSeq?: number;
  turnId: string;
}): string {
  const previous = args.previousSeq ?? "none";
  return (
    `native:${JUNIOR_NATIVE_EVENT_NAMESPACE}:agents_instructions_updated:` +
    `${args.turnId}:${args.action}:${previous}->${args.fingerprint}`
  );
}

/** Record one AGENTS.md bootstrap transition as host transcript metadata. */
export async function recordAgentsInstructionsUpdated(
  args: AgentsInstructionsTransitionArgs,
): Promise<void> {
  const previous = await loadAgentsEvent(args.conversationId);
  const instructions = args.instructions;
  if (
    previous &&
    ((!instructions && previous.content.action === "cleared") ||
      (instructions &&
        previous.content.action !== "cleared" &&
        previous.content.fingerprint === instructions.fingerprint &&
        previous.content.directory === instructions.directory))
  ) {
    return;
  }
  const action = !instructions
    ? "cleared"
    : previous && previous.content.action !== "cleared"
      ? "replaced"
      : "loaded";
  const fingerprint = instructions?.fingerprint ?? "cleared";
  const content = agentsInstructionsUpdatedEvent.parse({
    action,
    fingerprint,
    sources: instructions?.sources ?? [],
    ...(instructions ? { directory: instructions.directory } : {}),
    ...(instructions
      ? { textBytes: Buffer.byteLength(instructions.text, "utf8") }
      : {}),
  });
  await getConversationEventStore().append(args.conversationId, [
    {
      createdAtMs: Date.now(),
      idempotencyKey: agentsInstructionsIdempotencyKey({
        action,
        fingerprint,
        previousSeq: previous?.seq,
        turnId: args.turnId,
      }),
      data: {
        type: "structured_event",
        namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
        name: agentsInstructionsUpdatedEvent.eventName,
        version: agentsInstructionsUpdatedEvent.version,
        turnId: args.turnId,
        content,
      },
    },
  ]);
}

/** Load a previously selected execution profile for a resumed turn. */
export async function loadTurnRoute(args: {
  conversationId: string;
  turnId: string;
}): Promise<
  Extract<ConversationEvent["data"], { type: "turn_routed" }> | undefined
> {
  const event = await getConversationEventStore().loadByIdempotencyKey(
    args.conversationId,
    `turn:${args.turnId}:routed`,
  );
  if (!event) {
    return undefined;
  }
  if (event.data.type !== "turn_routed" || event.data.turnId !== args.turnId) {
    throw new Error(`Turn route key for "${args.turnId}" has invalid data`);
  }
  return event.data;
}

/** Record the execution profile selected for one turn without changing agent history. */
export async function recordTurnRoute(args: {
  conversationId: string;
  turnId: string;
  modelProfile: ModelProfile;
  modelId: string;
  reasoningLevel: TurnReasoningLevel;
  confidence?: number;
  source: "configured" | "inherited" | "router";
}): Promise<void> {
  await getConversationEventStore().append(args.conversationId, [
    {
      idempotencyKey: `turn:${args.turnId}:routed`,
      createdAtMs: Date.now(),
      data: {
        type: "turn_routed",
        turnId: args.turnId,
        modelProfile: args.modelProfile,
        modelId: args.modelId,
        reasoningLevel: args.reasoningLevel,
        ...(args.confidence !== undefined
          ? { confidence: args.confidence }
          : {}),
        source: args.source,
      },
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

/** Record one privacy-safe Guardian decision before the reviewed action continues. */
export async function recordGuardianActionReviewed(args: {
  conversationId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  costUsd?: number;
  decision: "allow" | "ask" | "deny";
  riskLevel: "low" | "medium" | "high" | "critical";
  userAuthorization: "high" | "medium" | "low" | "unknown";
}): Promise<void> {
  await getConversationEventStore().append(args.conversationId, [
    {
      data: {
        type: "guardian_action_reviewed",
        turnId: args.turnId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
        decision: args.decision,
        riskLevel: args.riskLevel,
        userAuthorization: args.userAuthorization,
      },
      createdAtMs: Date.now(),
    },
  ]);
}
