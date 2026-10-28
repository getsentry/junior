import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  conversationAnnotationInputSchema,
  type ConversationAnnotation,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversations,
} from "@/db/schema";

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
      const rows = await args.db
        .select()
        .from(juniorConversationAnnotations)
        .where(
          and(
            eq(
              juniorConversationAnnotations.conversationId,
              args.conversationId,
            ),
            eq(juniorConversationAnnotations.plugin, args.plugin),
          ),
        )
        .orderBy(desc(juniorConversationAnnotations.updatedAt));
      return rows.flatMap((row) => annotationFromRow(row) ?? []);
    },
  };
}

/**
 * Load stored annotations for one conversation, newest update first. A root
 * Conversation also reads the annotations of its child Conversations.
 */
export async function listConversationAnnotations(
  db: JuniorDatabase,
  conversationId: string,
): Promise<ConversationAnnotation[]> {
  const byConversation = await listConversationAnnotationsById(db, [
    conversationId,
  ]);
  return byConversation.get(conversationId) ?? [];
}

/**
 * Load stored annotations for a bounded set of conversations, newest update
 * first. Child agents save annotations in their own Conversation, but people
 * see the root Conversation. So a root also reads the annotations of every
 * Conversation in its tree. The newest annotation wins for each object.
 */
export async function listConversationAnnotationsById(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationAnnotation[]>> {
  const byConversation = new Map<string, ConversationAnnotation[]>();
  if (conversationIds.length === 0) return byConversation;

  const requested = new Set(conversationIds);
  const rows = await db
    .select({
      annotation: juniorConversationAnnotations,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversationAnnotations)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationAnnotations.conversationId,
      ),
    )
    .where(
      or(
        inArray(juniorConversationAnnotations.conversationId, [...requested]),
        inArray(juniorConversations.rootConversationId, [...requested]),
      ),
    )
    .orderBy(desc(juniorConversationAnnotations.updatedAt));

  const seen = new Set<string>();
  for (const { annotation: row, rootConversationId } of rows) {
    const annotation = annotationFromRow(row);
    if (!annotation) continue;
    // A root's own row matches both ids; add it once.
    for (const owner of new Set([row.conversationId, rootConversationId])) {
      if (!owner || !requested.has(owner)) continue;
      const objectKey = JSON.stringify([owner, row.plugin, row.kind, row.key]);
      if (seen.has(objectKey)) continue;
      seen.add(objectKey);
      const current = byConversation.get(owner);
      if (current) {
        current.push(annotation);
      } else {
        byConversation.set(owner, [annotation]);
      }
    }
  }
  return byConversation;
}
