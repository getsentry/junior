import {
  identitySchema,
  type Actor,
  type Identity,
  type PluginLogger,
} from "@sentry/junior-plugin-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { MemoryDb } from "./store";

const linkedIdentityRowSchema = z.object({
  displayName: z.string().nullable(),
  handle: z.string().nullable(),
  id: z.string(),
  provider: z.string(),
  providerSubjectId: z.string(),
  providerTenantId: z.string().nullable(),
});

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("Linked identity query did not return rows");
  }
  return result.rows;
}

/** Read every identity linked to the verified web Actor. */
export async function readLinkedIdentities(
  db: MemoryDb,
  actor: Actor | undefined,
  log: PluginLogger,
): Promise<Identity[] | undefined> {
  if (actor?.platform !== "web" || !actor.email) return undefined;
  try {
    const result = await db.execute(sql`
      SELECT
        linked.id,
        linked.provider,
        linked.provider_subject_id AS "providerSubjectId",
        nullif(linked.provider_tenant_id, '') AS "providerTenantId",
        linked.display_name AS "displayName",
        linked.handle
      FROM junior_identities AS current_identity
      INNER JOIN junior_identities AS linked
        ON linked.user_id = current_identity.user_id
        AND linked.kind = 'user'
      WHERE current_identity.kind = 'user'
        AND current_identity.provider = 'junior'
        AND current_identity.provider_tenant_id = ''
        AND current_identity.provider_subject_id = ${actor.email.trim().toLowerCase()}
      ORDER BY
        linked.provider,
        linked.provider_tenant_id,
        linked.provider_subject_id
    `);
    return linkedIdentityRowSchema.array().parse(queryRows(result)).map((row) =>
      identitySchema.parse({
        id: row.id,
        provider: row.provider,
        providerSubjectId: row.providerSubjectId,
        ...(row.providerTenantId
          ? { providerTenantId: row.providerTenantId }
          : {}),
        ...(row.displayName ? { displayName: row.displayName } : {}),
        ...(row.handle ? { handle: row.handle } : {}),
      }),
    );
  } catch {
    log.warn("memory_identity_resolve_failed");
    return undefined;
  }
}
