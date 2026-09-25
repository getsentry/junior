import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import {
  codeChangeInputSchema,
  type CodeChangeInput,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";

/** Record the latest details for one code change created by Junior. */
export async function recordCodeChange(
  db: JuniorDatabase,
  provider: string,
  input: CodeChangeInput,
): Promise<void> {
  const change = codeChangeInputSchema.parse(input);
  const repositories = await db
    .insert(juniorCodeRepositories)
    .values({
      id: randomUUID(),
      name: change.repository.name,
      provider,
      providerId: change.repository.providerId,
      url: change.repository.url,
      updatedAt: change.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        juniorCodeRepositories.provider,
        juniorCodeRepositories.providerId,
      ],
      set: {
        name: change.repository.name,
        ...(change.repository.url ? { url: change.repository.url } : undefined),
        updatedAt: change.updatedAt,
      },
      where: lte(juniorCodeRepositories.updatedAt, change.updatedAt),
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
            eq(juniorCodeRepositories.providerId, change.repository.providerId),
          ),
        )
        .limit(1);
  const repositoryId = repositories[0]?.id ?? existingRepositories[0]?.id;
  if (!repositoryId) {
    throw new Error("Code repository upsert returned no row");
  }

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
    url: change.url ?? null,
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
