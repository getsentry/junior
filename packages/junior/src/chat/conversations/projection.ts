/**
 * Agent-step projection.
 *
 * Materializes the model-visible Pi context and derived run facts (connected
 * MCP providers, latest instruction actor) from the durable `AgentStepStore`.
 * The current model context is exactly the highest context epoch's `pi_message`
 * steps in `seq` order; host-only step types (activity, provider connection,
 * authorization requests, epoch markers) never reach `agent.state.messages`.
 * Compaction, handoff, and rollback open a new epoch instead of rewriting
 * history, so the context reducer only walks one epoch. The epoch marker binds
 * the projection's model profile, which later replacements inherit, and the
 * exact resolved model id used when the epoch was opened for audit.
 */
import { isDeepStrictEqual } from "node:util";
import type { PiMessage } from "@/chat/pi/messages";
import {
  contextProvenance,
  type AuthorizationKind,
  type PiMessageProvenance,
  type SessionProjection,
} from "@/chat/state/session-log";
import type {
  AgentStepEntry,
  StoredAgentStep,
} from "@/chat/conversations/history";
import { getAgentStepStore } from "@/chat/db";
import { ensureLegacyConversationImport } from "@/chat/conversations/legacy-import";
import type { ModelProfile } from "@/chat/model-profile";

type PiMessageStepEntry = Extract<AgentStepEntry, { type: "pi_message" }>;
type AuthorizationCompletedEntry = Extract<
  AgentStepEntry,
  { type: "authorization_completed" }
>;

/** Current conversation context with its authoritative model binding. */
export interface ConversationProjection extends SessionProjection {
  /** Model profile bound to this projection. */
  modelProfile: ModelProfile;
  /** Audit snapshot; runtime model selection remains profile-driven. */
  modelId: string | undefined;
}

/** Aligned step projection: `provenance[i]` and `seqs[i]` describe `messages[i]`. */
export interface StepProjection extends ConversationProjection {
  /** The `seq` of the step each projected message came from. */
  seqs: number[];
}

/**
 * Synthesize the host observation a completed authorization contributes to Pi.
 * Mirrors the legacy session-log projection so a resumed run still learns the
 * provider unblocked and should retry the blocked operation.
 */
function authorizationObservationMessage(
  entry: AuthorizationCompletedEntry,
  createdAtMs: number,
): PiMessage {
  const label = entry.kind === "mcp" ? "MCP authorization" : "Authorization";
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${label} completed for provider "${entry.provider}". Continue the blocked request and retry the provider operation if needed.`,
      },
    ],
    timestamp: createdAtMs,
  } as PiMessage;
}

function piEntryProvenance(entry: PiMessageStepEntry): PiMessageProvenance {
  return entry.provenance ?? contextProvenance;
}

/**
 * Materialize Pi messages with aligned provenance and source seqs from one
 * epoch's steps. Steps above `maxSeq` (when given) are excluded so a terminal
 * turn record reproduces exactly the boundary it committed.
 */
export function projectSteps(
  steps: StoredAgentStep[],
  opts?: { maxSeq?: number },
): StepProjection {
  const messages: PiMessage[] = [];
  const provenance: PiMessageProvenance[] = [];
  const seqs: number[] = [];
  let modelProfile: ModelProfile = "standard";
  let modelId: string | undefined;
  for (const step of steps) {
    if (opts?.maxSeq !== undefined && step.seq > opts.maxSeq) {
      break;
    }
    if (step.entry.type === "context_epoch_started") {
      modelProfile = step.entry.modelProfile ?? "standard";
      modelId = step.entry.modelId;
      continue;
    }
    if (step.entry.type === "pi_message") {
      messages.push(step.entry.message);
      provenance.push(piEntryProvenance(step.entry));
      seqs.push(step.seq);
      continue;
    }
    if (step.entry.type === "authorization_completed") {
      messages.push(
        authorizationObservationMessage(step.entry, step.createdAtMs),
      );
      provenance.push(contextProvenance);
      seqs.push(step.seq);
    }
  }
  return { messages, provenance, seqs, modelProfile, modelId };
}

/** Distinct MCP providers durably connected in the given steps, sorted. */
function connectedMcpProvidersFromSteps(steps: StoredAgentStep[]): string[] {
  const providers = new Set<string>();
  for (const step of steps) {
    if (step.entry.type === "mcp_provider_connected") {
      providers.add(step.entry.provider);
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
  existing: SessionProjection;
  nextMessages: PiMessage[];
  matchingPrefix: number;
  explicitProvenance?: PiMessageProvenance[];
  trailingMessageProvenance?: PiMessageProvenance[];
  newMessageProvenance?: PiMessageProvenance;
}): PiMessageProvenance[] {
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

/**
 * Bridge a straggler's legacy Redis history into SQL before an execution read.
 *
 * Runtime reads run under the conversation lease the worker already holds, so
 * this is the once-only lazy-import seam. Removed with the rest of the one-time
 * import after the Redis TTL horizon.
 */
async function importLegacyIfNeeded(args: ScopedConversation): Promise<void> {
  await ensureLegacyConversationImport({ conversationId: args.conversationId });
}

/** Load the current-epoch Pi projection for a conversation. */
export async function loadProjection(
  args: ScopedConversation,
): Promise<PiMessage[]> {
  await importLegacyIfNeeded(args);
  const steps = await getAgentStepStore().loadCurrentEpoch(args.conversationId);
  return projectSteps(steps).messages;
}

/** Load the current-epoch Pi projection with aligned per-message provenance. */
export async function loadConversationProjection(
  args: ScopedConversation,
): Promise<ConversationProjection> {
  await importLegacyIfNeeded(args);
  const steps = await getAgentStepStore().loadCurrentEpoch(args.conversationId);
  const { messages, provenance, modelProfile, modelId } = projectSteps(steps);
  return { messages, provenance, modelProfile, modelId };
}

/** Open a standard initial epoch before a conversation's first model request. */
export async function openConversationProjection(
  args: ScopedConversation & { modelId: string },
): Promise<ConversationProjection> {
  await importLegacyIfNeeded(args);
  const stepStore = getAgentStepStore();
  const steps = await stepStore.loadCurrentEpoch(args.conversationId);
  const projection = projectSteps(steps);
  if (
    steps.some(
      (step) =>
        step.entry.type === "context_epoch_started" ||
        step.entry.type === "pi_message",
    )
  ) {
    return projection;
  }
  // Host facts may predate the first model request. Keep them in epoch 0 and
  // make that formerly implicit epoch explicit before model execution.
  await stepStore.startEpoch(args.conversationId, {
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
 * Load a turn's committed Pi projection from the durable step store.
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
}): Promise<StepProjection | undefined> {
  await importLegacyIfNeeded(args);
  const stepStore = getAgentStepStore();
  // A record that committed no messages materializes the live projection, the
  // same way count-based records with a zero cursor did.
  if (args.committedSeq < 0) {
    return projectSteps(await stepStore.loadCurrentEpoch(args.conversationId));
  }
  const history = await stepStore.loadHistory(args.conversationId);
  const committedStep = history.find((step) => step.seq === args.committedSeq);
  if (!committedStep) {
    return undefined;
  }
  const epochSteps = history.filter(
    (step) => step.contextEpoch === committedStep.contextEpoch,
  );
  return args.includeTail
    ? projectSteps(epochSteps)
    : projectSteps(epochSteps, { maxSeq: args.committedSeq });
}

/** Load MCP providers durably connected in this conversation's current epoch. */
export async function loadConnectedMcpProviders(
  args: ScopedConversation,
): Promise<string[]> {
  await importLegacyIfNeeded(args);
  const steps = await getAgentStepStore().loadCurrentEpoch(args.conversationId);
  return connectedMcpProvidersFromSteps(steps);
}

function messageTimestamp(message: PiMessage): number {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

/**
 * Commit the turn's Pi history: append when it advanced the committed
 * projection normally, or open a `rollback` epoch when it diverged (a
 * provider-retry trim regenerated trailing assistant output). Returns the
 * resolved provenance, the per-message step seqs, and the `seq` boundary that
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
  provenance?: PiMessageProvenance[];
  /** Explicit provenance for the trailing newly committed messages. */
  trailingMessageProvenance?: PiMessageProvenance[];
  /** Default applied to the last new user message when no explicit array. */
  newMessageProvenance?: PiMessageProvenance;
}): Promise<{
  committedSeq: number;
  messageSeqs: number[];
  provenance: PiMessageProvenance[];
}> {
  const stepStore = getAgentStepStore();
  const currentSteps = await stepStore.loadCurrentEpoch(args.conversationId);
  const existing = projectSteps(currentSteps);
  const matchingPrefix = countMatchingPrefix(existing.messages, args.messages);
  const nextProvenance = resolveCommitProvenance({
    existing,
    nextMessages: args.messages,
    matchingPrefix,
    ...(args.provenance ? { explicitProvenance: args.provenance } : {}),
    ...(args.trailingMessageProvenance
      ? { trailingMessageProvenance: args.trailingMessageProvenance }
      : {}),
    ...(args.newMessageProvenance
      ? { newMessageProvenance: args.newMessageProvenance }
      : {}),
  });
  if (currentSteps.length === 0) {
    await stepStore.startEpoch(args.conversationId, {
      reason: "initial",
      modelProfile: "standard",
      modelId: args.modelId,
      messages: args.messages.map((message, index) => ({
        message,
        createdAtMs: messageTimestamp(message),
        provenance: nextProvenance[index]!,
      })),
    });
  } else if (matchingPrefix === existing.messages.length) {
    const newMessages = args.messages.slice(matchingPrefix);
    await stepStore.append(
      args.conversationId,
      newMessages.map((message, index) => ({
        entry: {
          type: "pi_message" as const,
          message,
          provenance: nextProvenance[matchingPrefix + index]!,
        },
        createdAtMs: messageTimestamp(message),
      })),
    );
  } else {
    await stepStore.startEpoch(args.conversationId, {
      reason: "rollback",
      modelProfile: existing.modelProfile,
      modelId: args.modelId,
      messages: args.messages.map((message, index) => ({
        message,
        createdAtMs: messageTimestamp(message),
        provenance: nextProvenance[index]!,
      })),
    });
  }
  const committed = projectSteps(
    await stepStore.loadCurrentEpoch(args.conversationId),
  );
  return {
    committedSeq: committed.seqs.at(-1) ?? -1,
    messageSeqs: committed.seqs,
    provenance: nextProvenance,
  };
}

/** Record a successful MCP provider connection without duplicating the fact. */
export async function recordMcpProviderConnected(args: {
  conversationId: string;
  provider: string;
}): Promise<void> {
  const stepStore = getAgentStepStore();
  const steps = await stepStore.loadCurrentEpoch(args.conversationId);
  if (connectedMcpProvidersFromSteps(steps).includes(args.provider)) {
    return;
  }
  await stepStore.append(args.conversationId, [
    {
      entry: { type: "mcp_provider_connected", provider: args.provider },
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
  const stepStore = getAgentStepStore();
  const steps = await stepStore.loadCurrentEpoch(args.conversationId);
  if (
    steps.some(
      (step) =>
        step.entry.type === "authorization_requested" &&
        step.entry.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await stepStore.append(args.conversationId, [
    {
      entry: {
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
  const stepStore = getAgentStepStore();
  const steps = await stepStore.loadCurrentEpoch(args.conversationId);
  if (
    steps.some(
      (step) =>
        step.entry.type === "authorization_completed" &&
        step.entry.authorizationId === args.authorizationId,
    )
  ) {
    return;
  }
  await stepStore.append(args.conversationId, [
    {
      entry: {
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
  args?: unknown;
  createdAtMs?: number;
  toolCallId: string;
  toolName: string;
}): Promise<void> {
  await getAgentStepStore().append(args.conversationId, [
    {
      entry: {
        type: "tool_execution_started",
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        ...(args.args !== undefined ? { args: args.args } : {}),
      },
      createdAtMs: args.createdAtMs ?? Date.now(),
    },
  ]);
}
