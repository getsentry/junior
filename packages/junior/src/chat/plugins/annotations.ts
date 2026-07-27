import { and, desc, eq } from "drizzle-orm";
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
