import { createHash } from "node:crypto";
import * as z from "zod";
import { slackExternalRefIdSchema } from "./work-object";

// 16 bytes of SHA-256 in base64url. A plugin key can be 256 characters, so the
// reference stores a fixed-size digest and the detail handler matches it
// against the Conversation's saved annotations.
const KEY_DIGEST_LENGTH = 22;

// Slack kept short references in the earlier
// base64url(JSON [conversationId, plugin, key]) form, and posted messages
// cannot be changed. Keep reading them.
const legacyRefSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.string().min(1),
]);

function decodeLegacyAnnotationRef(id: string) {
  try {
    return legacyRefSchema.safeParse(
      JSON.parse(Buffer.from(id, "base64url").toString("utf8")),
    ).data;
  } catch {
    return undefined;
  }
}

/** Return the fixed-size digest that identifies one annotation in a reference. */
export function annotationKeyDigest(plugin: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify([plugin, key]))
    .digest("base64url")
    .slice(0, KEY_DIGEST_LENGTH);
}

/**
 * Build the Slack `external_ref.id` for an annotation, or null when the
 * Conversation ID is too long for Slack's limit.
 */
export function encodeAnnotationRef(
  conversationId: string,
  plugin: string,
  key: string,
): string | null {
  const id =
    annotationKeyDigest(plugin, key) +
    Buffer.from(conversationId, "utf8").toString("base64url");
  return slackExternalRefIdSchema.safeParse(id).success ? id : null;
}

/**
 * Split a current or legacy annotation `external_ref.id` into its
 * Conversation ID and key digest.
 */
export function decodeAnnotationRef(
  id: string,
): { conversationId: string; keyDigest: string } | null {
  const legacy = decodeLegacyAnnotationRef(id);
  if (legacy) {
    const [conversationId, plugin, key] = legacy;
    return { conversationId, keyDigest: annotationKeyDigest(plugin, key) };
  }
  const keyDigest = id.slice(0, KEY_DIGEST_LENGTH);
  const encoded = id.slice(KEY_DIGEST_LENGTH);
  const conversationId = Buffer.from(encoded, "base64url").toString("utf8");
  // Buffer ignores invalid input, so require an exact round trip.
  if (
    !conversationId ||
    Buffer.from(conversationId, "utf8").toString("base64url") !== encoded
  ) {
    return null;
  }
  return { conversationId, keyDigest };
}
