import type { ObjectType } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { MessageAttachment } from "@/chat/attachments/input";
import type { MessageCard, MessageCardRef } from "@/chat/conversations/cards";
import type { ReviewItemChangeRecord } from "@/chat/review-items/change-record";

type ConversationRole = "assistant" | "system" | "user";

export interface ConversationAuthor {
  email?: string | undefined;
  fullName?: string;
  isBot?: boolean | undefined;
  userId?: string;
  userName?: string | undefined;
}

/** One Event listed on a conversation message. */
export interface ConversationMessageEvent {
  eventType: string;
  /** Resource label, used to group Events under one heading. */
  label?: string;
  objectType?: ObjectType;
  trustedSummary?: string;
}

export interface ConversationMessageMeta {
  cards?: MessageCard[];
  objectCards?: MessageCardRef[];
  attachments?: MessageAttachment[];
  slackFileIds?: string[];
  attachmentCount?: number;
  /** Known message provenance. Omit when unknown; never invent a default. */
  source?: "slack" | "web";
  /** First Event of the batch. Marks the message as an Event message. */
  eventType?: string;
  /** Namespace of the first Event, such as `github`. */
  eventNamespace?: string;
  eventObjectType?: ObjectType | undefined;
  /**
   * The Watch Events when several arrived together. A Message that also
   * records Review item changes lists its own Event here even when it has
   * one. Omitted otherwise.
   */
  events?: ConversationMessageEvent[];
  explicitMention?: boolean | undefined;
  /** Short summary supplied by the Event publisher. */
  trustedSummary?: string;
  imageAttachmentCount?: number | undefined;
  imageFileIds?: string[];
  imagesHydrated?: boolean;
  /** Quiet message from older history: stored, but not delivered. */
  quiet?: true;
  replied?: boolean;
  /** Person changes to Review items that this Message records. */
  reviewItemChanges?: ReviewItemChangeRecord[];
  slackTs?: string;
  skippedReason?: string | undefined;
}

export interface ConversationMessage {
  author?: ConversationAuthor;
  /** Identity of the author, resolved at ingress. Assistant output has none. */
  authorIdentityId?: string;
  createdAtMs: number;
  id: string;
  meta?: ConversationMessageMeta;
  role: ConversationRole;
  /** Event seq of the saved Message. Missing until it is saved and loaded. */
  seq?: number;
  text: string;
}

export interface ConversationProcessingState {
  activeTurnId?: string | undefined;
  lastCompletedAtMs?: number | undefined;
  pendingAuth?: ConversationPendingAuthState | undefined;
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
  backfillCompletedAtMs?: number | undefined;
  byFileId: Record<string, ConversationVisionSummary>;
}

export interface ThreadConversationState {
  /** Seq where the loaded Message window starts, after older Messages were trimmed. */
  historyFromSeq?: number | undefined;
  messages: ConversationMessage[];
  processing: ConversationProcessingState;
  schemaVersion: 1;
  vision: ConversationVisionState;
}

function defaultConversationState(): ThreadConversationState {
  return {
    schemaVersion: 1,
    messages: [],
    processing: {},
    vision: {
      byFileId: {},
    },
  };
}

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);
const optionalString = nonEmptyString.optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const pendingAuthCommonFields = {
  provider: nonEmptyString,
  actorId: nonEmptyString,
  sessionId: nonEmptyString,
  linkSentAtMs: z.number(),
  scope: optionalString,
};

const pendingAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    ...pendingAuthCommonFields,
    kind: z.literal("mcp"),
    authSessionId: nonEmptyString,
  }),
  z.object({ ...pendingAuthCommonFields, kind: z.literal("plugin") }),
]);

const visionSummarySchema = z.object({
  summary: nonEmptyString,
  analyzedAtMs: z.number().refine((value) => value !== 0),
});

// Stored thread state is read leniently: each invalid field falls back on its
// own instead of failing the whole read.
const storedThreadStateSchema = z.object({
  conversation: z
    .object({
      processing: z
        .object({
          activeTurnId: optionalString,
          lastCompletedAtMs: optionalNumber,
          pendingAuth: pendingAuthSchema.optional().catch(undefined),
        })
        .catch({}),
      vision: z
        .object({
          backfillCompletedAtMs: optionalNumber,
          byFileId: z.record(z.string(), z.unknown()).catch({}),
        })
        .catch({ byFileId: {} }),
    })
    .catch({ processing: {}, vision: { byFileId: {} } }),
});

/** Safely coerce an unknown persisted value into a ThreadConversationState. */
export function coerceThreadConversationState(
  value: unknown,
): ThreadConversationState {
  const parsed = storedThreadStateSchema.safeParse(value);
  if (!parsed.success) {
    return defaultConversationState();
  }

  const { processing, vision } = parsed.data.conversation;
  const byFileId: Record<string, ConversationVisionSummary> = {};
  for (const [fileId, entry] of Object.entries(vision.byFileId)) {
    if (fileId.trim().length === 0) continue;
    const summary = visionSummarySchema.safeParse(entry);
    if (!summary.success) continue;
    byFileId[fileId] = summary.data;
  }

  return {
    schemaVersion: 1,
    // Conversation history lives in SQL. The operator upgrade reads any old
    // thread-state history; live code starts empty and hydrates canonical events.
    messages: [],
    processing,
    vision: {
      backfillCompletedAtMs: vision.backfillCompletedAtMs,
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
