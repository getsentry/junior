import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const CURSOR_CONTEXT = "junior-conversation-report-cursor";

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

function cursorSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Cannot sign conversation cursor without JUNIOR_SECRET");
  }
  return secret;
}

/** Sign one encoded cursor with the domain-separated server secret. */
function signature(payload: string): string {
  return createHmac("sha256", cursorSecret())
    .update(`${CURSOR_CONTEXT}:${payload}`)
    .digest("base64url");
}

/** Encode an authenticated, conversation-bound event position for an API cursor. */
export function encodeConversationCursor(
  payload: Omit<ConversationCursorPayload, "version">,
): string {
  const encoded = Buffer.from(
    JSON.stringify({ ...payload, version: 1 }),
    "utf8",
  ).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

/** Decode an authenticated reporting cursor for the expected conversation. */
export function decodeConversationCursor(args: {
  conversationId: string;
  cursor: string;
}): { seq: number } | undefined {
  const [encoded, actualSignature, extra] = args.cursor.split(".");
  if (!encoded || !actualSignature || extra !== undefined) return undefined;
  const expected = Buffer.from(signature(encoded));
  const actual = Buffer.from(actualSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined;
  }

  try {
    const parsed = conversationCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (parsed.conversationId !== args.conversationId) {
      return undefined;
    }
    return { seq: parsed.seq };
  } catch {
    return undefined;
  }
}
