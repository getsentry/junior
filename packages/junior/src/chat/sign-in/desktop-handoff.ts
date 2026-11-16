/**
 * Desktop sign-in handoff.
 *
 * Google blocks its sign-in page in embedded webviews, so the Junior desktop
 * app signs in through the system browser. The browser session then moves to
 * the app webview: the browser gets a short-lived code that holds its session
 * cookies, encrypted with the sign-in secret and bound to a PKCE challenge of
 * the app (RFC 7636). Only the app has the verifier, so only it can redeem the
 * code. Sessions are stateless cookies, so the code is not single-use; the
 * short lifetime and the verifier limit replay.
 */
import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import * as z from "zod";

const CODE_LIFETIME = "60s";
const CODE_AUDIENCE = "junior-desktop";
const KEY_INFO = "junior desktop sign-in handoff";

/** One session cookie that the desktop app sets in its webview. */
export interface SessionCookie {
  maxAgeSeconds: number;
  name: string;
  secure: boolean;
  value: string;
}

const sessionCookieSchema = z.object({
  maxAgeSeconds: z.number().int().positive(),
  name: z.string().min(1),
  secure: z.boolean(),
  value: z.string().min(1),
});

const codePayloadSchema = z.object({
  challenge: z.string().min(1),
  cookies: z.array(sessionCookieSchema).min(1),
});

function handoffKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, "", KEY_INFO, 32));
}

function s256(verifier: string): Buffer {
  return createHash("sha256").update(verifier).digest();
}

/** Encrypt session cookies into a code that only the PKCE verifier redeems. */
export async function createDesktopHandoffCode(args: {
  codeChallenge: string;
  cookies: SessionCookie[];
  secret: string;
}): Promise<string> {
  return await new EncryptJWT({
    challenge: args.codeChallenge,
    cookies: args.cookies,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(CODE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(CODE_LIFETIME)
    .encrypt(handoffKey(args.secret));
}

/**
 * Return the session cookies of a code, or undefined for an expired,
 * tampered, or foreign code, or a verifier that does not match.
 */
export async function redeemDesktopHandoffCode(args: {
  code: string;
  codeVerifier: string;
  secret: string;
}): Promise<SessionCookie[] | undefined> {
  let payload: unknown;
  try {
    ({ payload } = await jwtDecrypt(args.code, handoffKey(args.secret), {
      audience: CODE_AUDIENCE,
    }));
  } catch {
    return undefined;
  }
  const parsed = codePayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const expected = Buffer.from(parsed.data.challenge, "base64url");
  const actual = s256(args.codeVerifier);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined;
  }
  return parsed.data.cookies;
}
