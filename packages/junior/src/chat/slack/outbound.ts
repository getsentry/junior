import { randomBytes } from "node:crypto";
import { SlackActionError } from "@/chat/slack/client";
import type { SlackMessageBlock } from "@/chat/slack/footer";
import {
  getSlackClient,
  normalizeSlackConversationId,
  withSlackRetries,
} from "@/chat/slack/client";
import { normalizeSlackEmojiName } from "@/chat/slack/emoji";
import { parseSlackUserId, type SlackChannelId } from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";

const MAX_SLACK_MESSAGE_TEXT_CHARS = 40_000;
const SLACK_DELIVERY_LOCATOR_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_SLACK_DELIVERY_PART_INDEX = 9_999;
const SLACK_WEB_API_RATE_LIMITED_ERROR_CODE = "slack_webapi_rate_limited_error";
const MAX_RECOVERABLE_SLACK_RETRY_AFTER_MS = 60 * 60 * 1_000;
// Slack applies a 15-item conversations.replies limit to some commercially
// distributed apps. One page per invocation also lets durable orchestration
// honor the provider's rate limit between reconciliation attempts.
const SLACK_RECONCILIATION_PAGE_SIZE = 15;

/** Public Slack metadata event type used to reconcile ambiguous reply writes. */
export const SLACK_DELIVERY_METADATA_EVENT_TYPE = "junior_delivery";

declare const slackDeliveryLocatorBrand: unique symbol;

/** Opaque, public-safe 128-bit locator used only to correlate Slack delivery. */
export type SlackDeliveryLocator = string & {
  readonly [slackDeliveryLocatorBrand]: true;
};

/** Public-safe marker attached to one part of a recoverable Slack delivery. */
export interface SlackDeliveryMetadata {
  locator: SlackDeliveryLocator;
  partIndex: number;
  version: 1;
}

/** Create an opaque random locator suitable for public Slack message metadata. */
export function createSlackDeliveryLocator(): SlackDeliveryLocator {
  return randomBytes(16).toString("base64url") as SlackDeliveryLocator;
}

/** Parse a persisted delivery locator without accepting arbitrary metadata text. */
export function parseSlackDeliveryLocator(
  value: string,
): SlackDeliveryLocator | undefined {
  return SLACK_DELIVERY_LOCATOR_PATTERN.test(value)
    ? (value as SlackDeliveryLocator)
    : undefined;
}

function requireSlackDeliveryMetadata(
  metadata: SlackDeliveryMetadata,
): SlackDeliveryMetadata {
  const locator = parseSlackDeliveryLocator(metadata.locator);
  if (!locator) {
    throw new Error("Slack delivery metadata requires a valid locator");
  }
  if (metadata.version !== 1) {
    throw new Error("Slack delivery metadata requires version 1");
  }
  if (
    !Number.isInteger(metadata.partIndex) ||
    metadata.partIndex < 0 ||
    metadata.partIndex > MAX_SLACK_DELIVERY_PART_INDEX
  ) {
    throw new Error("Slack delivery metadata requires a valid part index");
  }
  return { locator, partIndex: metadata.partIndex, version: 1 };
}

function toSlackMessageMetadata(metadata: SlackDeliveryMetadata): {
  event_type: typeof SLACK_DELIVERY_METADATA_EVENT_TYPE;
  event_payload: {
    locator: SlackDeliveryLocator;
    part_index: number;
    version: 1;
  };
} {
  const validated = requireSlackDeliveryMetadata(metadata);
  return {
    event_type: SLACK_DELIVERY_METADATA_EVENT_TYPE,
    event_payload: {
      locator: validated.locator,
      part_index: validated.partIndex,
      version: validated.version,
    },
  };
}

function requireSlackConversationId(
  channelId: string,
  action: string,
): SlackChannelId {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) {
    throw new Error(`${action} requires a valid channel ID`);
  }
  return normalized;
}

function requireSlackThreadTimestamp(threadTs: string, action: string): string {
  const normalized = threadTs.trim();
  if (!normalized) {
    throw new Error(`${action} requires a thread timestamp`);
  }
  return normalized;
}

function requireSlackMessageTimestamp(
  timestamp: string,
  action: string,
): SlackMessageTs {
  const normalized = parseSlackMessageTs(timestamp);
  if (!normalized) {
    throw new Error(`${action} requires a target message timestamp`);
  }
  return normalized;
}

function requireSlackMessageText(text: string, action: string): string {
  if (text.trim().length === 0) {
    throw new Error(`${action} requires non-empty text`);
  }
  if (text.length > MAX_SLACK_MESSAGE_TEXT_CHARS) {
    throw new Error(
      `${action} text exceeds Slack's 40000 character truncation limit`,
    );
  }
  return text;
}

/** Resolve a Slack message permalink without making read-only workflows fail on lookup errors. */
export async function getSlackMessagePermalink(args: {
  channelId: SlackChannelId;
  messageTs: SlackMessageTs;
}): Promise<string | undefined> {
  try {
    const response = await withSlackRetries(
      () =>
        getSlackClient().chat.getPermalink({
          channel: args.channelId,
          message_ts: args.messageTs,
        }),
      3,
      {
        action: "chat.getPermalink",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": args.channelId,
          "app.slack.message_ts": args.messageTs,
        },
      },
    );
    return response.permalink;
  } catch {
    return undefined;
  }
}

/** Post Slack `mrkdwn` text to a conversation or thread via the shared outbound boundary. */
export async function postSlackMessage(input: {
  blocks?: SlackMessageBlock[];
  channelId: string;
  text: string;
  threadTs?: string;
  includePermalink?: boolean;
}): Promise<{ ts: SlackMessageTs; permalink?: string }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack message posting",
  );
  const text = requireSlackMessageText(input.text, "Slack message posting");
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(
        input.threadTs,
        "Slack thread message posting",
      )
    : undefined;

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.postMessage({
        channel: channelId,
        text,
        ...(input.blocks?.length
          ? {
              blocks: input.blocks as unknown as Array<Record<string, unknown>>,
            }
          : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    3,
    {
      action: "chat.postMessage",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        ...(threadTs ? { "app.slack.thread_ts": threadTs } : {}),
      },
    },
  );

  const messageTs = parseSlackMessageTs(response.ts);
  if (!messageTs) {
    throw new Error("Slack message posted without ts");
  }

  return {
    ts: messageTs,
    ...(input.includePermalink
      ? {
          permalink: await getSlackMessagePermalink({
            channelId,
            messageTs,
          }),
        }
      : {}),
  };
}

export type RecoverableSlackPostResult =
  | { outcome: "accepted"; ts: SlackMessageTs }
  | {
      outcome: "definitive_failure";
      reason: "api_rejected" | "missing_token";
    }
  | {
      outcome: "retryable_absence";
      reason: "rate_limited";
      retryAtMs?: number;
    }
  | {
      outcome: "uncertain";
      reason:
        | "invalid_response"
        | "server_error"
        | "transport_error"
        | "unknown_error";
    };

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function hasExplicitSlackApiRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  return Boolean(
    data &&
    typeof data === "object" &&
    typeof (data as { error?: unknown }).error === "string",
  );
}

function classifyRecoverableSlackPostFailure(
  error: unknown,
): Exclude<RecoverableSlackPostResult, { outcome: "accepted" }> {
  const statusCode = getErrorStatusCode(error);
  if (statusCode !== undefined && statusCode >= 500) {
    return { outcome: "uncertain", reason: "server_error" };
  }
  if (
    statusCode === 429 ||
    (error !== null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code ===
        SLACK_WEB_API_RATE_LIMITED_ERROR_CODE) ||
    (error instanceof SlackActionError && error.code === "rate_limited")
  ) {
    const candidate = error as {
      retryAfter?: unknown;
      retryAfterSeconds?: unknown;
      headers?: Record<string, unknown>;
    };
    const rawRetryAfter =
      candidate.retryAfter ??
      candidate.retryAfterSeconds ??
      candidate.headers?.["retry-after"] ??
      candidate.headers?.["Retry-After"];
    const retryAfterSeconds = Number(rawRetryAfter);
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.min(
          Math.max(0, retryAfterSeconds * 1_000),
          MAX_RECOVERABLE_SLACK_RETRY_AFTER_MS,
        )
      : undefined;
    return {
      outcome: "retryable_absence",
      reason: "rate_limited",
      ...(retryAfterMs !== undefined
        ? { retryAtMs: Date.now() + retryAfterMs }
        : {}),
    };
  }
  if (error instanceof SlackActionError && error.code === "missing_token") {
    return { outcome: "definitive_failure", reason: "missing_token" };
  }
  if (
    hasExplicitSlackApiRejection(error) ||
    (error instanceof SlackActionError && error.apiError)
  ) {
    return { outcome: "definitive_failure", reason: "api_rejected" };
  }

  const candidate = error as { code?: unknown; message?: unknown } | undefined;
  if (
    typeof candidate?.code === "string" ||
    (typeof candidate?.message === "string" &&
      candidate.message.toLowerCase().includes("socket hang up"))
  ) {
    return { outcome: "uncertain", reason: "transport_error" };
  }
  return { outcome: "uncertain", reason: "unknown_error" };
}

/**
 * Attempt one recoverable Slack write. Ambiguous writes are never retried;
 * callers must persist the uncertain result and reconcile it separately.
 */
export async function postRecoverableSlackMessage(input: {
  blocks?: SlackMessageBlock[];
  channelId: string;
  metadata: SlackDeliveryMetadata;
  text: string;
  threadTs?: string;
}): Promise<RecoverableSlackPostResult> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Recoverable Slack message posting",
  );
  const text = requireSlackMessageText(
    input.text,
    "Recoverable Slack message posting",
  );
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(
        input.threadTs,
        "Recoverable Slack thread message posting",
      )
    : undefined;
  const metadata = toSlackMessageMetadata(input.metadata);

  try {
    const response = await getSlackClient().chat.postMessage({
      channel: channelId,
      text,
      metadata,
      ...(input.blocks?.length
        ? {
            blocks: input.blocks as unknown as Array<Record<string, unknown>>,
          }
        : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const ts = parseSlackMessageTs(response.ts);
    return ts
      ? { outcome: "accepted", ts }
      : { outcome: "uncertain", reason: "invalid_response" };
  } catch (error) {
    return classifyRecoverableSlackPostFailure(error);
  }
}

export type RecoverableSlackReconciliationResult =
  | { outcome: "accepted"; ts: SlackMessageTs }
  | { outcome: "confirmed_absent" }
  | { outcome: "continue"; nextCursor: string }
  | { outcome: "retryable"; retryAtMs?: number }
  | { outcome: "unresolved" };

interface SlackReconciliationIdentity {
  appId?: string;
  botId?: string;
  userId?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMessageFromSlackIdentity(
  message: Record<string, unknown>,
  identity: SlackReconciliationIdentity,
): boolean {
  const comparisons = [
    [readNonEmptyString(message.app_id), identity.appId],
    [readNonEmptyString(message.bot_id), identity.botId],
    [readNonEmptyString(message.user), identity.userId],
  ] as const;
  return comparisons.some(
    ([actual, expected]) => actual !== undefined && actual === expected,
  );
}

function hasSlackDeliveryMetadata(
  message: Record<string, unknown>,
  expected: ReturnType<typeof toSlackMessageMetadata>,
): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const candidate = metadata as {
    event_payload?: unknown;
    event_type?: unknown;
  };
  if (candidate.event_type !== expected.event_type) return false;
  if (!candidate.event_payload || typeof candidate.event_payload !== "object") {
    return false;
  }
  const payload = candidate.event_payload as Record<string, unknown>;
  return (
    Object.keys(payload).length === 3 &&
    payload.locator === expected.event_payload.locator &&
    payload.part_index === expected.event_payload.part_index &&
    payload.version === expected.event_payload.version
  );
}

/**
 * Resolve an uncertain Slack write by finding its exact public-safe marker.
 * The caller persists continuation cursors between rate-limited page reads;
 * provider failures remain unresolved and never authorize a duplicate repost.
 */
export async function reconcileRecoverableSlackMessage(input: {
  channelId: string;
  cursor?: string;
  metadata: SlackDeliveryMetadata;
  oldestTs: string;
  threadTs: string;
}): Promise<RecoverableSlackReconciliationResult> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Recoverable Slack message reconciliation",
  );
  const threadTs = requireSlackMessageTimestamp(
    input.threadTs,
    "Recoverable Slack message reconciliation",
  );
  const oldestTs = requireSlackMessageTimestamp(
    input.oldestTs,
    "Recoverable Slack message reconciliation",
  );
  const metadata = toSlackMessageMetadata(input.metadata);

  try {
    const client = getSlackClient();
    const auth = await client.auth.test();
    const identity: SlackReconciliationIdentity = {
      appId: readNonEmptyString(auth.app_id),
      botId: readNonEmptyString(auth.bot_id),
      userId: readNonEmptyString(auth.user_id),
    };
    if (!identity.appId && !identity.botId && !identity.userId) {
      return { outcome: "unresolved" };
    }

    const cursor = readNonEmptyString(input.cursor);
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      oldest: oldestTs,
      inclusive: true,
      include_all_metadata: true,
      limit: SLACK_RECONCILIATION_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const rawMessage of response.messages ?? []) {
      const message = rawMessage as unknown as Record<string, unknown>;
      if (
        !hasSlackDeliveryMetadata(message, metadata) ||
        !isMessageFromSlackIdentity(message, identity)
      ) {
        continue;
      }
      const ts = parseSlackMessageTs(message.ts);
      return ts ? { outcome: "accepted", ts } : { outcome: "unresolved" };
    }

    const nextCursor = readNonEmptyString(
      response.response_metadata?.next_cursor,
    );
    if (nextCursor) return { outcome: "continue", nextCursor };
    return response.has_more === true
      ? { outcome: "unresolved" }
      : { outcome: "confirmed_absent" };
  } catch (error) {
    const classified = classifyRecoverableSlackPostFailure(error);
    if (classified.outcome === "retryable_absence") {
      return {
        outcome: "retryable",
        ...(classified.retryAtMs !== undefined
          ? { retryAtMs: classified.retryAtMs }
          : {}),
      };
    }
    return { outcome: "unresolved" };
  }
}

/** Delete a previously posted Slack message through the shared outbound boundary. */
export async function deleteSlackMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
}): Promise<void> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack message deletion",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack message deletion",
  );

  await withSlackRetries(
    () =>
      getSlackClient().chat.delete({
        channel: channelId,
        ts: timestamp,
      }),
    3,
    {
      action: "chat.delete",
      idempotent: true,
      spanAttributes: {
        "app.slack.channel_id": channelId,
        "app.slack.message_ts": timestamp,
      },
    },
  );
}

/**
 * Post an ephemeral Slack message. Delivery is best-effort on Slack's side, but
 * request validation and Web API behavior are centralized here.
 */
export async function postSlackEphemeralMessage(input: {
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
}): Promise<{ messageTs?: string }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack ephemeral message posting",
  );
  const userId = parseSlackUserId(input.userId);
  if (!userId) {
    throw new Error("Slack ephemeral message posting requires a user ID");
  }
  const text = requireSlackMessageText(
    input.text,
    "Slack ephemeral message posting",
  );
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(
        input.threadTs,
        "Slack ephemeral thread message posting",
      )
    : undefined;

  const response = await withSlackRetries(
    () =>
      getSlackClient().chat.postEphemeral({
        channel: channelId,
        user: userId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    3,
    {
      action: "chat.postEphemeral",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        "app.slack.user_id": userId,
        ...(threadTs ? { "app.slack.thread_ts": threadTs } : {}),
      },
    },
  );

  return {
    messageTs: response.message_ts,
  };
}

/** Minimal Slack file metadata exposed outside the Slack client boundary. */
export interface SlackUploadedFile {
  id?: string;
}

/** Upload files into a Slack conversation or thread via the shared outbound file boundary. */
export async function uploadFilesToConversation(input: {
  channelId: string;
  initialComment?: string;
  threadTs?: string;
  files: Array<{ data: Buffer; filename: string }>;
}): Promise<{ files?: SlackUploadedFile[] }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack file upload",
  );
  const threadTs = input.threadTs
    ? requireSlackThreadTimestamp(input.threadTs, "Slack file upload")
    : undefined;
  if (input.files.length === 0) {
    throw new Error("Slack file upload requires at least one file");
  }
  const fileUploads = input.files.map((file) => {
    const filename = file.filename.trim();
    if (!filename) {
      throw new Error(
        "Slack file upload requires every file to have a filename",
      );
    }
    return {
      file: file.data,
      filename,
    };
  });

  const initialComment = input.initialComment?.trim();
  const response = await withSlackRetries(
    () =>
      getSlackClient().filesUploadV2({
        channel_id: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(initialComment ? { initial_comment: initialComment } : {}),
        file_uploads: fileUploads,
      }),
    3,
    {
      action: "filesUploadV2",
      spanAttributes: {
        "app.slack.channel_id": channelId,
        ...(threadTs ? { "app.slack.thread_ts": threadTs } : {}),
      },
    },
  );

  return {
    files: (response.files ?? []).flatMap((completion) =>
      (completion.files ?? []).map((file) => (file.id ? { id: file.id } : {})),
    ),
  };
}

/** Upload files into a Slack thread via the shared outbound file boundary. */
export async function uploadFilesToThread(input: {
  channelId: string;
  threadTs: string;
  files: Array<{ data: Buffer; filename: string }>;
}): Promise<void> {
  await uploadFilesToConversation({
    ...input,
    threadTs: requireSlackThreadTimestamp(input.threadTs, "Slack file upload"),
  });
}

/** Add a reaction to a Slack message, treating `already_reacted` as idempotent success. */
export async function addReactionToMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
  emoji: string;
}): Promise<{ ok: true }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack reaction",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack reaction",
  );
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction requires a valid emoji alias name");
  }

  try {
    await withSlackRetries(
      () =>
        getSlackClient().reactions.add({
          channel: channelId,
          timestamp,
          name: emoji,
        }),
      3,
      {
        action: "reactions.add",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": channelId,
          "app.slack.message_ts": timestamp,
          "app.slack.reaction": emoji,
        },
      },
    );
  } catch (error) {
    if (error instanceof SlackActionError && error.code === "already_reacted") {
      return { ok: true };
    }
    throw error;
  }

  return { ok: true };
}

/** Remove a reaction from a Slack message, treating `no_reaction` as idempotent success. */
export async function removeReactionFromMessage(input: {
  channelId: string;
  timestamp: SlackMessageTs;
  emoji: string;
}): Promise<{ ok: true }> {
  const channelId = requireSlackConversationId(
    input.channelId,
    "Slack reaction removal",
  );
  const timestamp = requireSlackMessageTimestamp(
    input.timestamp,
    "Slack reaction removal",
  );
  const emoji = normalizeSlackEmojiName(input.emoji);
  if (!emoji) {
    throw new Error("Slack reaction removal requires a valid emoji alias name");
  }

  try {
    await withSlackRetries(
      () =>
        getSlackClient().reactions.remove({
          channel: channelId,
          timestamp,
          name: emoji,
        }),
      3,
      {
        action: "reactions.remove",
        idempotent: true,
        spanAttributes: {
          "app.slack.channel_id": channelId,
          "app.slack.message_ts": timestamp,
          "app.slack.reaction": emoji,
        },
      },
    );
  } catch (error) {
    if (error instanceof SlackActionError && error.code === "no_reaction") {
      return { ok: true };
    }
    throw error;
  }

  return { ok: true };
}

export const slackOutboundPolicy = {
  maxMessageTextChars: MAX_SLACK_MESSAGE_TEXT_CHARS,
};
