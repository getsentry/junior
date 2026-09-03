import { isRecord, toOptionalNumber, toOptionalString } from "@/chat/coerce";

type ConversationRole = "assistant" | "system" | "user";

export interface ConversationAuthor {
  email?: string;
  fullName?: string;
  isBot?: boolean;
  userId?: string;
  userName?: string;
}

export interface ConversationMessageMeta {
  attachmentCount?: number;
  /** Known message provenance. Omit when unknown; never invent a default. */
  source?: "slack" | "web";
  eventType?: string;
  explicitMention?: boolean;
  /** Short summary supplied by the Resource event publisher. */
  trustedSummary?: string;
  imageAttachmentCount?: number;
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
  coveredMessageCount: number;
  createdAtMs: number;
  id: string;
  summary: string;
}

export interface ConversationProcessingState {
  activeTurnId?: string;
  lastCompletedAtMs?: number;
  pendingAuth?: ConversationPendingAuthState;
}

interface ConversationPendingAuthBase {
  linkSentAtMs: number;
  provider: string;
  actorId: string;
  scope?: string;
  sessionId: string;
}

export type ConversationPendingAuthState =
  | (ConversationPendingAuthBase & {
      authSessionId: string;
      kind: "mcp";
    })
  | (ConversationPendingAuthBase & {
      kind: "plugin";
    });

export interface ConversationVisionSummary {
  analyzedAtMs: number;
  summary: string;
}

export interface ConversationVisionState {
  backfillCompletedAtMs?: number;
  byFileId: Record<string, ConversationVisionSummary>;
}

export interface ThreadConversationState {
  compactions: ConversationCompaction[];
  messages: ConversationMessage[];
  processing: ConversationProcessingState;
  schemaVersion: 1;
  vision: ConversationVisionState;
}

function defaultConversationState(): ThreadConversationState {
  return {
    schemaVersion: 1,
    messages: [],
    compactions: [],
    processing: {},
    vision: {
      byFileId: {},
    },
  };
}

function coercePendingAuthState(
  value: unknown,
): ConversationPendingAuthState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = value.kind;
  const provider = toOptionalString(value.provider);
  const actorId = toOptionalString(value.actorId);
  const authSessionId = toOptionalString(value.authSessionId);
  const scope = toOptionalString(value.scope);
  const sessionId = toOptionalString(value.sessionId);
  const linkSentAtMs = toOptionalNumber(value.linkSentAtMs);
  if (
    (kind !== "mcp" && kind !== "plugin") ||
    !provider ||
    !actorId ||
    (kind === "mcp" && !authSessionId) ||
    !sessionId ||
    typeof linkSentAtMs !== "number"
  ) {
    return undefined;
  }

  const base = {
    provider,
    actorId,
    ...(scope ? { scope } : undefined),
    sessionId,
    linkSentAtMs,
  };
  return kind === "mcp"
    ? { ...base, authSessionId: authSessionId!, kind }
    : { ...base, kind };
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
  // Conversation history lives in SQL. The operator upgrade reads any old
  // thread-state history; live code starts empty and hydrates canonical events.
  const messages: ConversationMessage[] = [];
  const compactions: ConversationCompaction[] = [];

  const rawProcessing = isRecord(rawConversation.processing)
    ? rawConversation.processing
    : {};
  const processing: ConversationProcessingState = {
    activeTurnId: toOptionalString(rawProcessing.activeTurnId),
    lastCompletedAtMs: toOptionalNumber(rawProcessing.lastCompletedAtMs),
    pendingAuth: coercePendingAuthState(rawProcessing.pendingAuth),
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
    processing,
    vision: {
      backfillCompletedAtMs: toOptionalNumber(rawVision.backfillCompletedAtMs),
      byFileId,
    },
  };
}

/**
 * Wrap active conversation control into the thread scratch envelope.
 *
 * Visible history lives in SQL. Image summaries use a separate disposable
 * cache, so thread scratch does not retain them.
 */
export function buildConversationStatePatch(
  conversation: ThreadConversationState,
): {
  conversation: Pick<ThreadConversationState, "schemaVersion" | "processing">;
} {
  return {
    conversation: {
      schemaVersion: 1,
      processing: { ...conversation.processing },
    },
  };
}
