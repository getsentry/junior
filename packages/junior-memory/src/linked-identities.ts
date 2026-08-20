import { type Actor, type Identity } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { alias, pgTable, text } from "drizzle-orm/pg-core";
import type { MemoryDb } from "./store";

const identities = pgTable("junior_identities", {
  displayName: text("display_name"),
  handle: text("handle"),
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  provider: text("provider").notNull(),
  providerSubjectId: text("provider_subject_id").notNull(),
  providerTenantId: text("provider_tenant_id").notNull(),
  userId: text("user_id"),
});
const linkedIdentity = alias(identities, "linked_identity");

/** Read every identity linked to the verified web Actor. */
export async function readLinkedIdentities(
  db: MemoryDb,
  actor: Actor | undefined,
): Promise<Identity[] | undefined> {
  if (actor?.platform !== "web" || !actor.email) return undefined;
  const rows = await db
    .select({
      displayName: linkedIdentity.displayName,
      handle: linkedIdentity.handle,
      id: linkedIdentity.id,
      provider: linkedIdentity.provider,
      providerSubjectId: linkedIdentity.providerSubjectId,
      providerTenantId: linkedIdentity.providerTenantId,
    })
    .from(identities)
    .innerJoin(
      linkedIdentity,
      and(
        eq(linkedIdentity.userId, identities.userId),
        eq(linkedIdentity.kind, "user"),
      ),
    )
    .where(
      and(
        eq(identities.kind, "user"),
        eq(identities.provider, "junior"),
        eq(identities.providerTenantId, ""),
        eq(
          identities.providerSubjectId,
          actor.email.trim().toLowerCase(),
        ),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerSubjectId: row.providerSubjectId,
    ...(row.providerTenantId
      ? { providerTenantId: row.providerTenantId }
      : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
  }));
}
