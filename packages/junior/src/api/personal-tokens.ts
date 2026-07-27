import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorApiTokens } from "@/db/schema";

const TOKEN_PREFIX = "jr_pat_";
const TOKEN_SUFFIX_LENGTH = 8;
const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

export interface PersonalTokenMetadata {
  id: string;
  name: string;
  tokenSuffix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface CreatedPersonalToken extends PersonalTokenMetadata {
  token: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function metadata(
  row: typeof juniorApiTokens.$inferSelect,
): PersonalTokenMetadata {
  return {
    id: row.id,
    name: row.name,
    tokenSuffix: row.tokenSuffix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Create a personal token and return its plaintext value exactly once. */
export async function createPersonalToken(args: {
  email: string;
  name: string;
  now?: Date;
}): Promise<CreatedPersonalToken> {
  const now = args.now ?? new Date();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: typeof juniorApiTokens.$inferInsert = {
    id: randomUUID(),
    ownerEmailNormalized: normalizeEmail(args.email),
    name: args.name.trim(),
    tokenHash: hashToken(token),
    tokenSuffix: token.slice(-TOKEN_SUFFIX_LENGTH),
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS),
  };
  await getDb().insert(juniorApiTokens).values(row);
  return { ...metadata({ ...row, lastUsedAt: null, revokedAt: null }), token };
}

/** List active personal tokens owned by one verified user. */
export async function listPersonalTokens(
  email: string,
  now = new Date(),
): Promise<PersonalTokenMetadata[]> {
  const rows = await getDb()
    .select()
    .from(juniorApiTokens)
    .where(
      and(
        eq(juniorApiTokens.ownerEmailNormalized, normalizeEmail(email)),
        isNull(juniorApiTokens.revokedAt),
        gt(juniorApiTokens.expiresAt, now),
      ),
    )
    .orderBy(desc(juniorApiTokens.createdAt));
  return rows.map(metadata);
}

/** Revoke a personal token owned by one verified user. */
export async function revokePersonalToken(args: {
  email: string;
  id: string;
  now?: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .update(juniorApiTokens)
    .set({ revokedAt: args.now ?? new Date() })
    .where(
      and(
        eq(juniorApiTokens.id, args.id),
        eq(juniorApiTokens.ownerEmailNormalized, normalizeEmail(args.email)),
        isNull(juniorApiTokens.revokedAt),
      ),
    )
    .returning({ id: juniorApiTokens.id });
  return rows.length > 0;
}

/** Resolve an active personal bearer token to its verified owner email. */
export async function authenticatePersonalToken(
  token: string,
  now = new Date(),
): Promise<string | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const rows = await getDb()
    .select({
      id: juniorApiTokens.id,
      ownerEmailNormalized: juniorApiTokens.ownerEmailNormalized,
    })
    .from(juniorApiTokens)
    .where(
      and(
        eq(juniorApiTokens.tokenHash, hashToken(token)),
        isNull(juniorApiTokens.revokedAt),
        gt(juniorApiTokens.expiresAt, now),
      ),
    )
    .limit(1);
  const match = rows[0];
  if (!match) return undefined;
  await getDb()
    .update(juniorApiTokens)
    .set({ lastUsedAt: now })
    .where(eq(juniorApiTokens.id, match.id));
  return match.ownerEmailNormalized;
}
