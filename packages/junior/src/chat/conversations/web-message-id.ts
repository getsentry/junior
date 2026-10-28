/**
 * Build the retry-stable Message id shared by web ingress and browser sends.
 * Keep the existing hash and prefix so retries still address stored Messages.
 */
export async function webMessageId(args: {
  conversationId: string;
  idempotencyKey: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${args.conversationId}\u0000${args.idempotencyKey}`,
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `api-msg:${hex.slice(0, 24)}`;
}
