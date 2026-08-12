import { and, desc, eq, inArray } from "drizzle-orm";
import {
  conversationAnnotationInputSchema,
  type ConversationAnnotation,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationAnnotations } from "@/db/schema";
export function createPluginAnnotations(args: {
  conversationId: string;
  db: JuniorDatabase;
  plugin: string;
}): PluginAnnotations {
  return {
    async upsert(input) {
      const annotation = conversationAnnotationInputSchema.parse(input);
      const now = new Date();
      await args.db
        .insert(juniorConversationAnnotations)
        .values({
          annotation,
          conversationId: args.conversationId,
          createdAt: now,
          key: annotation.key,
          kind: annotation.kind,
          plugin: args.plugin,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            juniorConversationAnnotations.conversationId,
            juniorConversationAnnotations.plugin,
            juniorConversationAnnotations.kind,
            juniorConversationAnnotations.key,
          ],
          set: { annotation, updatedAt: now },
        });
    },
    async remove(kind, key) {
      await args.db
        .delete(juniorConversationAnnotations)
        .where(
          and(
            eq(
              juniorConversationAnnotations.conversationId,
              args.conversationId,
            ),
            eq(juniorConversationAnnotations.plugin, args.plugin),
            eq(juniorConversationAnnotations.kind, kind),
            eq(juniorConversationAnnotations.key, key),
          ),
        );
    },
    async list() {
      return (
        await listConversationAnnotations(args.db, args.conversationId)
      ).filter((a) => a.plugin === args.plugin);
    },
  };
}
export type ConversationPullRequest = {
  label: string;
  status: "draft" | "open" | "merged";
  url: string;
};

/** Return the newest GitHub pull request annotation for each conversation. */
export async function listLatestConversationPullRequests(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationPullRequest>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(juniorConversationAnnotations)
    .where(
      and(
        inArray(juniorConversationAnnotations.conversationId, conversationIds),
        eq(juniorConversationAnnotations.plugin, "github"),
        eq(juniorConversationAnnotations.kind, "resource_link"),
      ),
    )
    .orderBy(
      desc(juniorConversationAnnotations.createdAt),
      desc(juniorConversationAnnotations.key),
    );
  const latest = new Map<string, ConversationPullRequest>();
  for (const row of rows) {
    if (latest.has(row.conversationId)) continue;
    const parsed = conversationAnnotationInputSchema.safeParse(row.annotation);
    if (
      !parsed.success ||
      parsed.data.kind !== "resource_link" ||
      !parsed.data.url.startsWith("https://github.com/") ||
      !parsed.data.url.includes("/pull/") ||
      !["draft", "open", "merged"].includes(parsed.data.status ?? "")
    ) {
      continue;
    }
    latest.set(row.conversationId, {
      label: parsed.data.label,
      status: parsed.data.status as ConversationPullRequest["status"],
      url: parsed.data.url,
    });
  }
  return latest;
}

export async function listConversationAnnotations(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationAnnotation[]> {
  const rows = await db
    .select()
    .from(juniorConversationAnnotations)
    .where(eq(juniorConversationAnnotations.conversationId, conversationId))
    .orderBy(desc(juniorConversationAnnotations.updatedAt));
  return rows.flatMap((row) => {
    const parsed = conversationAnnotationInputSchema.safeParse(row.annotation);
    return parsed.success
      ? [
          {
            ...parsed.data,
            plugin: row.plugin,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          },
        ]
      : [];
  });
}
