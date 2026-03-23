type ConversationRole = "assistant" | "system" | "user";

export interface ConversationAuthor {
  fullName?: string;
  isBot?: boolean;
  userId?: string;
  userName?: string;
}

export interface ConversationMessageMeta {
  explicitMention?: boolean;
  imageFileIds?: string[];
  imagesHydrated?: boolean;
  replied?: boolean;
  slackTs?: string;
  skippedReason?: string;
}

export interface ConversationMessage {
  author?: ConversationAuthor;
  createdAtMs: number;
  id: string;
  meta?: ConversationMessageMeta;
  role: ConversationRole;
  text: string;
}

export interface ConversationCompaction {
  coveredMessageIds: string[];
  createdAtMs: number;
  id: string;
  summary: string;
}

export interface ConversationBackfillState {
  completedAtMs?: number;
  source?: "recent_messages" | "thread_fetch";
}

export interface ConversationProcessingState {
  activeTurnId?: string;
  lastCompletedAtMs?: number;
}

export interface ConversationStats {
  compactedMessageCount: number;
  estimatedContextTokens: number;
  totalMessageCount: number;
  updatedAtMs: number;
}

export interface ConversationVisionSummary {
  analyzedAtMs: number;
  summary: string;
}

export interface ConversationVisionState {
  backfillCompletedAtMs?: number;
  byFileId: Record<string, ConversationVisionSummary>;
}

export interface ThreadConversationState {
  backfill: ConversationBackfillState;
  compactions: ConversationCompaction[];
  messages: ConversationMessage[];
  processing: ConversationProcessingState;
  schemaVersion: 1;
  stats: ConversationStats;
  vision: ConversationVisionState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function coerceRole(value: unknown): ConversationRole {
  return value === "assistant" || value === "system" || value === "user"
    ? value
    : "user";
}

function coerceAuthor(value: unknown): ConversationAuthor | undefined {
  if (!isRecord(value)) return undefined;
  const author: ConversationAuthor = {
    fullName: toOptionalString(value.fullName),
    userId: toOptionalString(value.userId),
    userName: toOptionalString(value.userName),
  };

  if (typeof value.isBot === "boolean") {
    author.isBot = value.isBot;
  }

  if (
    !author.fullName &&
    !author.userId &&
    !author.userName &&
    author.isBot === undefined
  ) {
    return undefined;
  }
  return author;
}

function coerceMessageMeta(
  value: unknown,
): ConversationMessageMeta | undefined {
  if (!isRecord(value)) return undefined;
  const meta: ConversationMessageMeta = {};
  if (typeof value.explicitMention === "boolean") {
    meta.explicitMention = value.explicitMention;
  }
  if (typeof value.replied === "boolean") {
    meta.replied = value.replied;
  }
  if (
    typeof value.skippedReason === "string" &&
    value.skippedReason.trim().length > 0
  ) {
    meta.skippedReason = value.skippedReason;
  }
  if (typeof value.slackTs === "string" && value.slackTs.trim().length > 0) {
    meta.slackTs = value.slackTs;
  }
  if (Array.isArray(value.imageFileIds)) {
    const imageFileIds = value.imageFileIds.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
    if (imageFileIds.length > 0) {
      meta.imageFileIds = imageFileIds;
    }
  }
  if (typeof value.imagesHydrated === "boolean") {
    meta.imagesHydrated = value.imagesHydrated;
  }
  if (
    meta.explicitMention === undefined &&
    meta.replied === undefined &&
    meta.skippedReason === undefined &&
    meta.slackTs === undefined &&
    meta.imageFileIds === undefined &&
    meta.imagesHydrated === undefined
  ) {
    return undefined;
  }
  return meta;
}

function defaultConversationState(): ThreadConversationState {
  const nowMs = Date.now();
  return {
    schemaVersion: 1,
    messages: [],
    compactions: [],
    backfill: {},
    processing: {},
    stats: {
      estimatedContextTokens: 0,
      totalMessageCount: 0,
      compactedMessageCount: 0,
      updatedAtMs: nowMs,
    },
    vision: {
      byFileId: {},
    },
  };
}

/** Safely coerce an unknown persisted value into a ThreadConversationState. */
export function coerceThreadConversationState(
  value: unknown,
): ThreadConversationState {
  if (!isRecord(value)) {
    return defaultConversationState();
  }

  const root = value as {
    conversation?: unknown;
  };
  const rawConversation = isRecord(root.conversation) ? root.conversation : {};
  const base = defaultConversationState();

  const rawMessages = Array.isArray(rawConversation.messages)
    ? rawConversation.messages
    : [];
  const messages: ConversationMessage[] = [];
  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const id = toOptionalString(item.id);
    const text = toOptionalString(item.text);
    const createdAtMs = toOptionalNumber(item.createdAtMs);
    if (!id || !text || !createdAtMs) continue;
    messages.push({
      id,
      role: coerceRole(item.role),
      text,
      createdAtMs,
      author: coerceAuthor(item.author),
      meta: coerceMessageMeta(item.meta),
    });
  }

  const rawCompactions = Array.isArray(rawConversation.compactions)
    ? rawConversation.compactions
    : [];
  const compactions: ConversationCompaction[] = [];
  for (const item of rawCompactions) {
    if (!isRecord(item)) continue;
    const id = toOptionalString(item.id);
    const summary = toOptionalString(item.summary);
    const createdAtMs = toOptionalNumber(item.createdAtMs);
    if (!id || !summary || !createdAtMs) continue;
    const coveredMessageIds = Array.isArray(item.coveredMessageIds)
      ? item.coveredMessageIds.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        )
      : [];
    compactions.push({
      id,
      summary,
      createdAtMs,
      coveredMessageIds,
    });
  }

  const rawBackfill = isRecord(rawConversation.backfill)
    ? rawConversation.backfill
    : {};
  const backfill: ConversationBackfillState = {
    completedAtMs: toOptionalNumber(rawBackfill.completedAtMs),
    source:
      rawBackfill.source === "recent_messages" ||
      rawBackfill.source === "thread_fetch"
        ? rawBackfill.source
        : undefined,
  };

  const rawProcessing = isRecord(rawConversation.processing)
    ? rawConversation.processing
    : {};
  const processing: ConversationProcessingState = {
    activeTurnId: toOptionalString(rawProcessing.activeTurnId),
    lastCompletedAtMs: toOptionalNumber(rawProcessing.lastCompletedAtMs),
  };

  const rawStats = isRecord(rawConversation.stats) ? rawConversation.stats : {};
  const stats: ConversationStats = {
    estimatedContextTokens:
      toOptionalNumber(rawStats.estimatedContextTokens) ??
      base.stats.estimatedContextTokens,
    totalMessageCount:
      toOptionalNumber(rawStats.totalMessageCount) ?? messages.length,
    compactedMessageCount:
      toOptionalNumber(rawStats.compactedMessageCount) ?? 0,
    updatedAtMs:
      toOptionalNumber(rawStats.updatedAtMs) ?? base.stats.updatedAtMs,
  };
  const rawVision = isRecord(rawConversation.vision)
    ? rawConversation.vision
    : {};
  const rawVisionByFileId = isRecord(rawVision.byFileId)
    ? rawVision.byFileId
    : {};
  const byFileId: Record<string, ConversationVisionSummary> = {};
  for (const [fileId, value] of Object.entries(rawVisionByFileId)) {
    if (typeof fileId !== "string" || fileId.trim().length === 0) continue;
    if (!isRecord(value)) continue;
    const summary = toOptionalString(value.summary);
    const analyzedAtMs = toOptionalNumber(value.analyzedAtMs);
    if (!summary || !analyzedAtMs) continue;
    byFileId[fileId] = {
      summary,
      analyzedAtMs,
    };
  }

  return {
    schemaVersion: 1,
    messages,
    compactions,
    backfill,
    processing,
    stats,
    vision: {
      backfillCompletedAtMs: toOptionalNumber(rawVision.backfillCompletedAtMs),
      byFileId,
    },
  };
}

/** Wrap a conversation state into the storage envelope for persistence. */
export function buildConversationStatePatch(
  conversation: ThreadConversationState,
): {
  conversation: ThreadConversationState;
} {
  return {
    conversation: {
      ...conversation,
      schemaVersion: 1,
      stats: {
        ...conversation.stats,
        totalMessageCount: conversation.messages.length,
        updatedAtMs: Date.now(),
      },
    },
  };
}
