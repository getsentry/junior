import { and, desc, eq, inArray } from "drizzle-orm";
import {
  conversationAnnotationInputSchema,
  type ConversationAnnotation,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationAnnotations } from "@/db/schema";

function annotationFromRow(row: {
  annotation: unknown;
  conversationId: string;
  createdAt: Date;
  plugin: string;
  updatedAt: Date;
}): ConversationAnnotation | undefined {
  const parsed = conversationAnnotationInputSchema.safeParse(row.annotation);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    plugin: row.plugin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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

/** Load stored annotations for one conversation, newest update first. */
export async function listConversationAnnotations(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationAnnotation[]> {
  const byConversation = await listConversationAnnotationsById(db, [
    conversationId,
  ]);
  return byConversation.get(conversationId) ?? [];
}

/** Load stored annotations for a bounded set of conversations. */
export async function listConversationAnnotationsById(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationAnnotation[]>> {
  const byConversation = new Map<string, ConversationAnnotation[]>();
  if (conversationIds.length === 0) return byConversation;

  const rows = await db
    .select()
    .from(juniorConversationAnnotations)
    .where(
      inArray(juniorConversationAnnotations.conversationId, [
        ...conversationIds,
      ]),
    )
    .orderBy(desc(juniorConversationAnnotations.updatedAt));

  for (const row of rows) {
    const annotation = annotationFromRow(row);
    if (!annotation) continue;
    const current = byConversation.get(row.conversationId);
    if (current) {
      current.push(annotation);
    } else {
      byConversation.set(row.conversationId, [annotation]);
    }
  }
  return byConversation;
}
