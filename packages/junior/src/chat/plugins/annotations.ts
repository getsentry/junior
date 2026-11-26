import { and, desc, eq } from "drizzle-orm";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import {
  conversationAnnotationInputSchema,
  type ConversationAnnotation,
  type ConversationAnnotationInput,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationAnnotations } from "@/db/schema";
import { conversationDetailTouch } from "@/chat/conversations/sql/detail-version";

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

/**
 * Add or replace one annotation of a plugin, and mark the Conversation detail
 * changed in the same statement. Pass a transaction to save it with other
 * changes.
 */
export async function upsertPluginAnnotation(
  db: JuniorDatabase,
  args: {
    annotation: ConversationAnnotationInput;
    conversationId: string;
    plugin: string;
  },
): Promise<void> {
  const annotation = conversationAnnotationInputSchema.parse(args.annotation);
  const now = new Date();
  await db
    .with(conversationDetailTouch(db, [args.conversationId]))
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
}

export function createPluginAnnotations(args: {
  conversationId: string;
  db: JuniorDatabase;
  plugin: string;
}): PluginAnnotations {
  return {
    async upsert(annotation) {
      await upsertPluginAnnotation(args.db, {
        annotation,
        conversationId: args.conversationId,
        plugin: args.plugin,
      });
    },
    async remove(kind, key) {
      await args.db
        .with(conversationDetailTouch(args.db, [args.conversationId]))
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
 * see the top-level Conversation. So each Conversation also reads the
 * annotations of every Conversation below it. The newest annotation wins for
 * each object.
 */
export async function listConversationAnnotationsById(
  db: JuniorDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationAnnotation[]>> {
  const byConversation = new Map<string, ConversationAnnotation[]>();
  if (conversationIds.length === 0) return byConversation;

  const rows = await db
    .select({
      annotation: juniorConversationAnnotations,
      owner: conversationSubtreeColumns.scopeConversationId,
    })
    .from(juniorConversationAnnotations)
    .innerJoin(
      conversationSubtree(conversationIds),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversationAnnotations.conversationId,
      ),
    )
    .orderBy(desc(juniorConversationAnnotations.updatedAt));

  const seen = new Set<string>();
  for (const { annotation: row, owner } of rows) {
    const annotation = annotationFromRow(row);
    if (!annotation) continue;
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
  return byConversation;
}
