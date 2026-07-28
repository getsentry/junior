import { and, eq } from "drizzle-orm";
import {
  actorSchema,
  type PluginUserPageActor,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type { JuniorDatabase } from "@/db/db";

/** Resolve runtime-owned actors linked to a viewer email from SQL. */
export async function readViewerActorsFromSql(
  db: JuniorDatabase,
  email: string,
): Promise<PluginUserPageActor[]> {
  const normalizedEmail = normalizeIdentityEmail(email);
  if (!normalizedEmail) return [];

  const rows = await db
    .select({
      displayName: juniorIdentities.displayName,
      email: juniorUsers.primaryEmail,
      handle: juniorIdentities.handle,
      provider: juniorIdentities.provider,
      providerSubjectId: juniorIdentities.providerSubjectId,
      providerTenantId: juniorIdentities.providerTenantId,
    })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorUsers.primaryEmailNormalized, normalizedEmail),
        eq(juniorIdentities.kind, "user"),
      ),
    );

  const actors: PluginUserPageActor[] = [];
  for (const row of rows) {
    const candidate =
      row.provider === "slack"
        ? {
            platform: "slack" as const,
            teamId: row.providerTenantId,
            userId: row.providerSubjectId,
            email: row.email,
            ...(row.displayName ? { fullName: row.displayName } : {}),
            ...(row.handle ? { userName: row.handle } : {}),
          }
        : row.provider === "local"
          ? {
              platform: "local" as const,
              userId: row.providerSubjectId,
              email: row.email,
              ...(row.displayName ? { fullName: row.displayName } : {}),
              ...(row.handle ? { userName: row.handle } : {}),
            }
          : undefined;
    if (!candidate) continue;
    const parsed = actorSchema.safeParse(candidate);
    if (parsed.success && parsed.data.platform !== "system") {
      actors.push(parsed.data);
    }
  }

  return actors;
}

/** Resolve runtime-owned actors linked to the authenticated viewer. */
export async function readViewerActors(
  email: string,
): Promise<PluginUserPageActor[]> {
  return await readViewerActorsFromSql(getDb(), email);
}
