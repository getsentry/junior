import { createHash } from "node:crypto";

/** An RFC 7636 S256 code challenge: 32 bytes as unpadded base64url. */
export const PKCE_CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** Return true when the RFC 7636 S256 verifier matches the challenge. */
export function pkceVerifierMatches(
  verifier: string,
  challenge: string,
): boolean {
  return (
    CODE_VERIFIER_PATTERN.test(verifier) &&
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}
