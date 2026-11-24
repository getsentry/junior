import { randomUUID } from "node:crypto";
import { and, arrayOverlaps, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  codeChangeFilterSchema,
  codeChangeInputSchema,
  codeRepositoryInputSchema,
  type CodeChange,
  type CodeChangeFilter,
  type CodeChangeInput,
  type CodeRepositoryInput,
} from "@sentry/junior-plugin-api";
import { setSpanAttributes } from "@/chat/logging";
import type { JuniorDatabase } from "@/db/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";

/**
 * Record the name of one code repository as the provider has it at
 * `updatedAt`, and return its id. An older update keeps the stored name.
 */
export async function recordCodeRepository(
  db: JuniorDatabase,
  provider: string,
  input: CodeRepositoryInput,
): Promise<string> {
  const repository = codeRepositoryInputSchema.parse(input);
  const repositories = await db
    .insert(juniorCodeRepositories)
    .values({
      id: randomUUID(),
      name: repository.name,
      provider,
      providerId: repository.providerId,
      updatedAt: repository.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        juniorCodeRepositories.provider,
        juniorCodeRepositories.providerId,
      ],
      set: {
        name: repository.name,
        updatedAt: repository.updatedAt,
      },
      where: lte(juniorCodeRepositories.updatedAt, repository.updatedAt),
    })
    .returning({ id: juniorCodeRepositories.id });
  const existingRepositories = repositories[0]
    ? []
    : await db
        .select({ id: juniorCodeRepositories.id })
        .from(juniorCodeRepositories)
        .where(
          and(
            eq(juniorCodeRepositories.provider, provider),
            eq(juniorCodeRepositories.providerId, repository.providerId),
          ),
        )
        .limit(1);
  const repositoryId = repositories[0]?.id ?? existingRepositories[0]?.id;
  if (!repositoryId) {
    throw new Error("Code repository upsert returned no row");
  }
  return repositoryId;
}

/** Record the latest details for one code change created by Junior. */
export async function recordCodeChange(
  db: JuniorDatabase,
  provider: string,
  input: CodeChangeInput,
): Promise<void> {
  const change = codeChangeInputSchema.parse(input);
  // Each provider event records the change again. These ids count distinct
  // code changes.
  setSpanAttributes({
    "vcs.change.id": String(change.number),
    "vcs.change.state": change.state,
    "vcs.provider.name": provider,
    "vcs.repository.name": change.repository.name,
  });
  const repositoryId = await recordCodeRepository(db, provider, {
    ...change.repository,
    updatedAt: change.updatedAt,
  });

  const conversationIds = sql.join(
    change.conversationIds.map((conversationId) => sql`${conversationId}`),
    sql`, `,
  );
  const values = {
    closedAt: change.closedAt ?? null,
    conversationIds:
      change.conversationIds.length > 0
        ? sql<string[]>`ARRAY(
            SELECT DISTINCT value
            FROM unnest(
              ${juniorCodeChanges.conversationIds}
              || ARRAY[${conversationIds}]::text[]
            ) AS value
            ORDER BY value
          )`
        : juniorCodeChanges.conversationIds,
    mergedAt: change.mergedAt ?? null,
    number: change.number,
    openedAt: change.openedAt,
    repositoryId,
    state: change.state,
    ...(change.title ? { title: change.title } : undefined),
    updatedAt: change.updatedAt,
  };
  await db
    .insert(juniorCodeChanges)
    .values({
      ...values,
      conversationIds: change.conversationIds,
      id: randomUUID(),
      provider,
      providerId: change.providerId,
    })
    .onConflictDoUpdate({
      target: [juniorCodeChanges.provider, juniorCodeChanges.providerId],
      set: values,
      where: lte(juniorCodeChanges.updatedAt, change.updatedAt),
    });
}

/** Move a code change's last activity forward. Older activity is a no-op. */
export async function recordCodeChangeActivity(
  db: JuniorDatabase,
  provider: string,
  input: { at: Date; number: number; repositoryProviderId: string },
): Promise<void> {
  const repository = db
    .select({ id: juniorCodeRepositories.id })
    .from(juniorCodeRepositories)
    .where(
      and(
        eq(juniorCodeRepositories.provider, provider),
        eq(juniorCodeRepositories.providerId, input.repositoryProviderId),
      ),
    );
  await db
    .update(juniorCodeChanges)
    .set({
      // GREATEST skips NULL, so the first activity sets the value.
      lastActivityAt: sql`GREATEST(${juniorCodeChanges.lastActivityAt}, ${input.at.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(juniorCodeChanges.provider, provider),
        inArray(juniorCodeChanges.repositoryId, repository),
        eq(juniorCodeChanges.number, input.number),
      ),
    );
}

/** Add conversation links to an existing code change. */
export async function associateCodeChangeConversations(
  db: JuniorDatabase,
  provider: string,
  input: { conversationIds: string[]; providerId: string },
): Promise<void> {
  if (input.conversationIds.length === 0) return;
  const conversationIds = sql.join(
    input.conversationIds.map((conversationId) => sql`${conversationId}`),
    sql`, `,
  );
  await db
    .update(juniorCodeChanges)
    .set({
      conversationIds: sql`ARRAY(
        SELECT DISTINCT value
        FROM unnest(
          ${juniorCodeChanges.conversationIds}
          || ARRAY[${conversationIds}]::text[]
        ) AS value
        ORDER BY value
      )`,
    })
    .where(
      and(
        eq(juniorCodeChanges.provider, provider),
        eq(juniorCodeChanges.providerId, input.providerId),
      ),
    );
}

/**
 * List one provider's code changes that match every part of the filter,
 * oldest update first, in one query.
 */
export async function listCodeChanges(
  db: JuniorDatabase,
  provider: string,
  input: CodeChangeFilter,
): Promise<CodeChange[]> {
  const filter = codeChangeFilterSchema.parse(input);
  const changes = juniorCodeChanges;
  const repositories = juniorCodeRepositories;
  const rows = await db
    .select({
      closedAt: changes.closedAt,
      conversationIds: changes.conversationIds,
      mergedAt: changes.mergedAt,
      number: changes.number,
      providerId: changes.providerId,
      repositoryName: repositories.name,
      repositoryProviderId: repositories.providerId,
      state: changes.state,
    })
    .from(changes)
    .innerJoin(repositories, eq(repositories.id, changes.repositoryId))
    .where(
      and(
        eq(changes.provider, provider),
        filter.conversationIds
          ? arrayOverlaps(changes.conversationIds, filter.conversationIds)
          : undefined,
        filter.providerIds
          ? inArray(changes.providerId, filter.providerIds)
          : undefined,
        filter.repository
          ? sql`lower(${repositories.name}) = ${filter.repository.name.toLowerCase()}`
          : undefined,
        filter.repository?.numbers
          ? inArray(changes.number, filter.repository.numbers)
          : undefined,
        filter.state ? eq(changes.state, filter.state) : undefined,
        filter.updatedBefore
          ? lt(changes.updatedAt, filter.updatedBefore)
          : undefined,
      ),
    )
    .orderBy(changes.updatedAt, changes.id);
  return rows.map((row) => ({
    closedAt: row.closedAt ?? undefined,
    conversationIds: row.conversationIds,
    mergedAt: row.mergedAt ?? undefined,
    number: row.number,
    providerId: row.providerId,
    repository: {
      name: row.repositoryName,
      providerId: row.repositoryProviderId,
    },
    state: row.state,
  }));
}
