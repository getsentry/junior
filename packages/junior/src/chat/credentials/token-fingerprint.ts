import { createHash } from "node:crypto";

/**
 * Build a short non-reversible fingerprint for correlating a credential across
 * mint, lease cache, and outbound injection without logging the secret.
 */
export function fingerprintCredentialToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

/**
 * Recover the credential token from a lease Authorization header value.
 *
 * Supports `Bearer <token>` and Git smart-HTTP
 * `Basic base64(x-access-token:<token>)`.
 */
export function credentialTokenFromAuthorizationHeader(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer?.[1]) {
    const token = bearer[1].trim();
    return token || undefined;
  }
  const basic = /^Basic\s+(.+)$/i.exec(trimmed);
  if (!basic?.[1]) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      return undefined;
    }
    const password = decoded.slice(separator + 1);
    return password || undefined;
  } catch {
    return undefined;
  }
}

/** Fingerprint the first Authorization token found in lease header transforms. */
export function fingerprintLeaseAuthorization(
  headerTransforms: Array<{ headers: Record<string, string> }>,
): string | undefined {
  for (const transform of headerTransforms) {
    for (const [key, value] of Object.entries(transform.headers)) {
      if (key.toLowerCase() !== "authorization") {
        continue;
      }
      const token = credentialTokenFromAuthorizationHeader(value);
      if (token) {
        return fingerprintCredentialToken(token);
      }
    }
  }
  return undefined;
}
