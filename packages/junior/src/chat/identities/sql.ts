import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import {
  normalizeIdentityEmail,
  type IdentityUpsert,
  type StoredIdentity,
} from "./identity";

type IdentityRow = typeof juniorIdentities.$inferSelect;

function dateFromMs(ms: number): Date {
  return new Date(ms);
}

function tenantId(value: string | undefined): string {
  return value ?? "";
}

async function upsertUser(
  executor: JuniorSqlDatabase,
  args: {
    displayName?: string;
    email: string;
    emailNormalized: string;
    nowMs: number;
  },
): Promise<string> {
  const rows = await executor
    .db()
    .insert(juniorUsers)
    .values({
      id: randomUUID(),
      primaryEmail: args.email,
      primaryEmailNormalized: args.emailNormalized,
      displayName: args.displayName ?? null,
      createdAt: dateFromMs(args.nowMs),
      updatedAt: dateFromMs(args.nowMs),
    })
    .onConflictDoUpdate({
      target: juniorUsers.primaryEmailNormalized,
      set: {
        displayName: sql`coalesce(${juniorUsers.displayName}, excluded.display_name)`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({ id: juniorUsers.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("User identity upsert returned no row");
  }
  return id;
}

async function existingIdentity(
  executor: JuniorSqlDatabase,
  identity: IdentityUpsert,
): Promise<IdentityRow | undefined> {
  const rows = await executor
    .db()
    .select()
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, identity.provider),
        eq(
          juniorIdentities.providerTenantId,
          tenantId(identity.providerTenantId),
        ),
        eq(juniorIdentities.providerSubjectId, identity.providerSubjectId),
      ),
    );
  return rows[0];
}

async function upsertIdentityRecord(
  executor: JuniorSqlDatabase,
  identity: IdentityUpsert,
  linkedUserId: string | undefined,
  nowMs: number,
): Promise<StoredIdentity> {
  const emailNormalized = normalizeIdentityEmail(identity.email);
  const email = emailNormalized
    ? identity.email?.trim() || emailNormalized
    : undefined;
  const existing = await existingIdentity(executor, identity);
  const userEmailNormalized =
    existing?.emailVerified && existing.emailNormalized
      ? existing.emailNormalized
      : identity.emailVerified
        ? emailNormalized
        : undefined;
  const userEmail =
    existing?.emailVerified && existing.email
      ? existing.email
      : (email ?? userEmailNormalized);
  const verifiedUserId =
    identity.kind === "user" && userEmailNormalized
      ? await upsertUser(executor, {
          email: userEmail ?? userEmailNormalized,
          emailNormalized: userEmailNormalized,
          nowMs,
          ...(existing?.displayName || identity.displayName
            ? { displayName: existing?.displayName ?? identity.displayName }
            : {}),
        })
      : undefined;
  if (
    existing?.userId &&
    verifiedUserId &&
    existing.userId !== verifiedUserId
  ) {
    throw new Error("Identity verified email conflicts with linked user");
  }
  if (
    linkedUserId &&
    verifiedUserId &&
    linkedUserId !== verifiedUserId
  ) {
    throw new Error("Linked identity conflicts with verified email user");
  }
  if (
    existing?.userId &&
    linkedUserId &&
    existing.userId !== linkedUserId
  ) {
    throw new Error("Identity conflicts with linked user");
  }
  const userId = existing?.userId ?? linkedUserId ?? verifiedUserId;
  const rows = await executor
    .db()
    .insert(juniorIdentities)
    .values({
      id: randomUUID(),
      userId: userId ?? null,
      kind: identity.kind,
      provider: identity.provider,
      providerTenantId: tenantId(identity.providerTenantId),
      providerSubjectId: identity.providerSubjectId,
      displayName: identity.displayName ?? null,
      handle: identity.handle ?? null,
      email: email ?? null,
      emailNormalized: emailNormalized ?? null,
      emailVerified: Boolean(identity.emailVerified && emailNormalized),
      avatarUrl: null,
      metadata: identity.metadata ?? null,
      createdAt: dateFromMs(nowMs),
      updatedAt: dateFromMs(nowMs),
    })
    .onConflictDoUpdate({
      target: [
        juniorIdentities.provider,
        juniorIdentities.providerTenantId,
        juniorIdentities.providerSubjectId,
      ],
      set: {
        kind: sql`excluded.kind`,
        userId: sql`coalesce(${juniorIdentities.userId}, excluded.user_id)`,
        displayName: linkedUserId
          ? sql`coalesce(excluded.display_name, ${juniorIdentities.displayName})`
          : sql`coalesce(${juniorIdentities.displayName}, excluded.display_name)`,
        handle: linkedUserId
          ? sql`coalesce(excluded.handle, ${juniorIdentities.handle})`
          : sql`coalesce(${juniorIdentities.handle}, excluded.handle)`,
        email: sql`case when ${juniorIdentities.emailVerified} then coalesce(${juniorIdentities.email}, excluded.email) when excluded.email_verified then excluded.email else coalesce(${juniorIdentities.email}, excluded.email) end`,
        emailNormalized: sql`case when ${juniorIdentities.emailVerified} then coalesce(${juniorIdentities.emailNormalized}, excluded.email_normalized) when excluded.email_verified then excluded.email_normalized else coalesce(${juniorIdentities.emailNormalized}, excluded.email_normalized) end`,
        emailVerified: sql`${juniorIdentities.emailVerified} OR excluded.email_verified`,
        avatarUrl: sql`coalesce(${juniorIdentities.avatarUrl}, excluded.avatar_url)`,
        metadata: sql`coalesce(${juniorIdentities.metadata}, excluded.metadata_json)`,
        updatedAt: sql`excluded.updated_at`,
      },
      ...(linkedUserId
        ? {
            setWhere: sql`${juniorIdentities.userId} IS NULL OR ${juniorIdentities.userId} = excluded.user_id`,
          }
        : {}),
    })
    .returning({
      id: juniorIdentities.id,
      userId: juniorIdentities.userId,
    });
  const row = rows[0];
  if (!row) {
    if (linkedUserId) {
      throw new Error("Identity conflicts with linked user");
    }
    throw new Error("Identity upsert returned no row");
  }
  return {
    id: row.id,
    ...(row.userId ? { userId: row.userId } : {}),
  };
}

/** Persist one provider identity observation and link verified emails to users. */
export async function upsertIdentity(
  executor: JuniorSqlDatabase,
  identity: IdentityUpsert,
  nowMs: number = Date.now(),
): Promise<StoredIdentity> {
  return await upsertIdentityRecord(executor, identity, undefined, nowMs);
}

/**
 * Persist one provider identity after a trusted account-linking flow.
 * Callers must use provider-verified account data, such as GitHub's authenticated
 * user response, never identity claims inferred from content such as Git commits.
 */
export async function upsertLinkedIdentity(
  executor: JuniorSqlDatabase,
  userId: string,
  identity: IdentityUpsert,
  nowMs: number = Date.now(),
): Promise<StoredIdentity> {
  return await upsertIdentityRecord(executor, identity, userId, nowMs);
}
