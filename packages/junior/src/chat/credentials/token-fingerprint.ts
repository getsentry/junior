import { createHmac } from "node:crypto";

const CREDENTIAL_FINGERPRINT_DOMAIN = "junior.credential-fingerprint.v1";

/** Short non-reversible id for correlating a credential without logging the secret. */
export function fingerprintCredentialToken(token: string): string {
  return createHmac("sha256", CREDENTIAL_FINGERPRINT_DOMAIN)
    .update(token, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** Recover a token from Bearer or git smart-HTTP Basic Authorization values. */
export function credentialTokenFromAuthorizationHeader(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer?.[1]?.trim()) return bearer[1].trim();
  const basic = /^Basic\s+(.+)$/i.exec(trimmed);
  if (!basic?.[1]) return undefined;
  try {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return undefined;
    const credential = decoded.slice(separator + 1);
    return credential || undefined;
  } catch {
    return undefined;
  }
}

/** Fingerprint the first Authorization token on lease header transforms. */
export function fingerprintLeaseAuthorization(
  headerTransforms: Array<{ headers: Record<string, string> }>,
): string | undefined {
  for (const transform of headerTransforms) {
    for (const [key, value] of Object.entries(transform.headers)) {
      if (key.toLowerCase() !== "authorization") continue;
      const token = credentialTokenFromAuthorizationHeader(value);
      if (token) return fingerprintCredentialToken(token);
    }
  }
  return undefined;
}
