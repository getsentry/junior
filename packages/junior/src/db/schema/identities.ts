import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IdentityKind } from "@/chat/identities/identity";
import { timestamptz } from "./timestamps";
import { juniorUsers } from "./users";

type SearchColumns = {
  displayName: AnyPgColumn;
  handle: AnyPgColumn;
  kind: AnyPgColumn;
  provider: AnyPgColumn;
};

/** Words of a Slack person's name and handle, for prefix search. */
export function slackPersonSearchDocument(table: SearchColumns): SQL {
  return sql`to_tsvector('simple', coalesce(${table.displayName}, '') || ' ' || coalesce(${table.handle}, ''))`;
}

/**
 * Slack people. Literal values, so a prepared query with this predicate
 * can use the partial index.
 */
export function slackPersonPredicate(table: SearchColumns): SQL {
  return sql`${table.provider} = 'slack' AND ${table.kind} = 'user'`;
}

export const juniorIdentities = pgTable(
  "junior_identities",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<IdentityKind>().notNull(),
    provider: text("provider").notNull(),
    providerTenantId: text("provider_tenant_id").notNull().default(""),
    providerSubjectId: text("provider_subject_id").notNull(),
    displayName: text("display_name"),
    handle: text("handle"),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    metadata: jsonb("metadata_json"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    userId: text("user_id").references(() => juniorUsers.id),
    emailNormalized: text("email_normalized"),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Last Google sign-in for a native Google identity. Null otherwise.
    signedInAt: timestamptz("signed_in_at"),
  },
  (table) => [
    uniqueIndex("junior_identities_provider_subject_uidx").on(
      table.provider,
      table.providerTenantId,
      table.providerSubjectId,
    ),
    index("junior_identities_user_idx").on(table.userId),
    index("junior_identities_verified_email_idx")
      .on(table.emailNormalized)
      .where(
        sql`${table.emailVerified} = true AND ${table.emailNormalized} IS NOT NULL`,
      ),
    index("junior_identities_kind_provider_idx").on(table.kind, table.provider),
    // The composer `@` menu matches word prefixes of Slack names and handles.
    // `api/people/search.query.ts` filters with the same two helpers.
    index("junior_identities_slack_person_search_idx")
      .using("gin", slackPersonSearchDocument(table))
      .where(slackPersonPredicate(table)),
  ],
);
