import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const EVENT_CURSOR_CONTEXT = "junior-conversation-report-cursor";
const FEED_CURSOR_CONTEXT = "junior-conversation-feed-cursor";

const conversationCursorPayloadSchema = z
  .object({
    conversationId: z.string().min(1),
    seq: z.number().int().min(-1),
    version: z.literal(1),
  })
  .strict();

type ConversationCursorPayload = z.infer<
  typeof conversationCursorPayloadSchema
>;

const conversationFeedCursorPayloadSchema = z
  .object({
    conversationId: z.string().min(1),
    lastActivityAtMs: z.number().int(),
    version: z.literal(1),
  })
  .strict();

type ConversationFeedCursorPayload = z.infer<
  typeof conversationFeedCursorPayloadSchema
>;

function cursorSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Cannot sign conversation cursor without JUNIOR_SECRET");
  }
  return secret;
}

/** Sign one encoded cursor with the domain-separated server secret. */
function signature(context: string, payload: string): string {
  return createHmac("sha256", cursorSecret())
    .update(`${context}:${payload}`)
    .digest("base64url");
}

function encodeSignedCursor(
  context: string,
  payload: ConversationCursorPayload | ConversationFeedCursorPayload,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${signature(context, encoded)}`;
}

/** Return the parsed payload only when the cursor signature is valid. */
function decodeSignedCursor<T>(
  context: string,
  cursor: string,
  schema: z.ZodType<T>,
): T | undefined {
  const [encoded, actualSignature, extra] = cursor.split(".");
  if (!encoded || !actualSignature || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(context, encoded));
  const actual = Buffer.from(actualSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined;
  }

  try {
    return schema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

/** Encode an authenticated, conversation-bound event position for an API cursor. */
export function encodeConversationCursor(
  payload: Omit<ConversationCursorPayload, "version">,
): string {
  return encodeSignedCursor(EVENT_CURSOR_CONTEXT, { ...payload, version: 1 });
}

/** Decode an authenticated reporting cursor for the expected conversation. */
export function decodeConversationCursor(args: {
  conversationId: string;
  cursor: string;
}): { seq: number } | undefined {
  const parsed = decodeSignedCursor(
    EVENT_CURSOR_CONTEXT,
    args.cursor,
    conversationCursorPayloadSchema,
  );
  if (!parsed || parsed.conversationId !== args.conversationId) {
    return undefined;
  }
  return { seq: parsed.seq };
}

/** Encode the last returned feed row as an authenticated next-page cursor. */
export function encodeConversationFeedCursor(
  position: Omit<ConversationFeedCursorPayload, "version">,
): string {
  return encodeSignedCursor(FEED_CURSOR_CONTEXT, { ...position, version: 1 });
}

/** Decode an authenticated feed cursor into the last row of the prior page. */
export function decodeConversationFeedCursor(
  cursor: string,
): Omit<ConversationFeedCursorPayload, "version"> | undefined {
  const parsed = decodeSignedCursor(
    FEED_CURSOR_CONTEXT,
    cursor,
    conversationFeedCursorPayloadSchema,
  );
  return parsed
    ? {
        conversationId: parsed.conversationId,
        lastActivityAtMs: parsed.lastActivityAtMs,
      }
    : undefined;
}
