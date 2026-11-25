/**
 * Stored sign-in sessions. The dashboard and the iOS app use the same kind of
 * token: random, opaque, and stored only as a SHA-256 hash. A session ends at
 * a fixed time after sign-in, and use does not extend it. Sign-out revokes
 * it at once.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorSignInSessions } from "@/db/schema";

// The prefix lets secret scanners find a leaked token. It carries no authority.
const TOKEN_PREFIX = "jr_ses_";
/** An app client signs in again after this, the same as its MCP grant. */
export const CLIENT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// Write `last_used_at` at most this often, so each request is one read.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;

/** The client that a session was made for. */
export type SignInSessionClient = "web" | "ios";

/** The verified user of one stored session. */
export interface SignInSessionUser {
  email: string;
  name?: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Create a session and return its token. Only its hash is stored. */
export async function createSignInSession(args: {
  client: SignInSessionClient;
  email: string;
  lifetimeMs: number;
  name?: string | undefined;
  now?: Date;
}): Promise<{ expiresAt: Date; token: string }> {
  const now = args.now ?? new Date();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + args.lifetimeMs);
  await getDb()
    .insert(juniorSignInSessions)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(token),
      userEmailNormalized: args.email.trim().toLowerCase(),
      userName: args.name?.trim() || null,
      client: args.client,
      createdAt: now,
      expiresAt,
    });
  return { expiresAt, token };
}

/** Resolve a session token that is not expired or revoked to its user. */
export async function authenticateSignInSession(
  token: string,
  now = new Date(),
): Promise<SignInSessionUser | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const tokenHash = hashToken(token);
  const rows = await getDb()
    .select({
      email: juniorSignInSessions.userEmailNormalized,
      lastUsedAt: juniorSignInSessions.lastUsedAt,
      name: juniorSignInSessions.userName,
    })
    .from(juniorSignInSessions)
    .where(
      and(
        eq(juniorSignInSessions.tokenHash, tokenHash),
        isNull(juniorSignInSessions.revokedAt),
        gt(juniorSignInSessions.expiresAt, now),
      ),
    )
    .limit(1);
  const match = rows[0];
  if (!match) return undefined;
  if (
    !match.lastUsedAt ||
    now.getTime() - match.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS
  ) {
    await getDb()
      .update(juniorSignInSessions)
      .set({ lastUsedAt: now })
      .where(eq(juniorSignInSessions.tokenHash, tokenHash));
  }
  return match.name
    ? { email: match.email, name: match.name }
    : { email: match.email };
}

/** Revoke one session token. An unknown or ended token changes nothing. */
export async function revokeSignInSession(
  token: string,
  now = new Date(),
): Promise<void> {
  if (!token.startsWith(TOKEN_PREFIX)) return;
  await getDb()
    .update(juniorSignInSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(juniorSignInSessions.tokenHash, hashToken(token)),
        isNull(juniorSignInSessions.revokedAt),
      ),
    );
}

/** Read a session token from an `Authorization: Bearer` header. */
export function bearerSignInSessionToken(request: Request): string | undefined {
  const value = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  return value?.startsWith(TOKEN_PREFIX) ? value : undefined;
}
