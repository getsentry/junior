import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import * as z from "zod";
import {
  conversationAnnotationInputSchema,
  type AnnotationAction,
  type ConversationAnnotation,
  type ConversationAnnotationInput,
  type PluginAnnotations,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversations,
} from "@/db/schema";
import { conversationDetailTouch } from "@/chat/conversations/sql/detail-version";
import {
  INBOX_SUBJECT_KINDS,
  pluginSubjectKind,
  type InboxItemSubject,
} from "@/chat/inbox-items/subjects";

/** The plugin name of core's own Annotations, such as Automation cards. */
export const CORE_ANNOTATION_PLUGIN = "junior";

/**
 * The core subject kinds of Annotations. An Annotation of a plugin object
 * uses the Inbox form of the plugin's own kind, `<plugin>:<kind>`.
 * - `automation`: an Automation, by its id, as for an Automation alert.
 * - `link`: an object whose provider id is not known, such as an attached
 *   link that no plugin names. The id is the link.
 */
export const ANNOTATION_SUBJECT_KINDS = {
  automation: INBOX_SUBJECT_KINDS.automation,
  link: "link",
} as const;

/**
 * Return the stored subject of an object Annotation from its own subject:
 * a core kind for core's own objects, else the plugin's kind in the Inbox
 * form. Undefined when the plugin did not name the object's provider id.
 */
export function annotationSubject(
  plugin: string,
  annotation: ConversationAnnotationInput,
): InboxItemSubject | undefined {
  if (annotation.kind !== "object" || !annotation.subject) return undefined;
  const { id, kind } = annotation.subject;
  return {
    id,
    kind:
      plugin === CORE_ANNOTATION_PLUGIN
        ? kind
        : pluginSubjectKind(plugin, kind),
  };
}

const savedAnnotationJsonSchema = z.looseObject({
  objectId: z.unknown().optional(),
});

function annotationFromRow(row: {
  annotation: unknown;
  conversationId: string;
  createdAt: Date;
  plugin: string;
  subjectId: string | null;
  subjectKind: string | null;
  updatedAt: Date;
}): ConversationAnnotation | undefined {
  // The subject lives in its columns. A card that an older release saved
  // kept the provider id in `objectId` instead.
  const saved = savedAnnotationJsonSchema.safeParse(row.annotation);
  if (!saved.success) return undefined;
  const { objectId: _objectId, ...json } = saved.data;
  const parsed = conversationAnnotationInputSchema.safeParse(json);
  if (!parsed.success) return undefined;
  // The inverse of `annotationSubject`. A `link` subject names no provider
  // id, so the annotation gets none.
  const ownKind =
    row.plugin === CORE_ANNOTATION_PLUGIN
      ? row.subjectKind === ANNOTATION_SUBJECT_KINDS.link
        ? undefined
        : row.subjectKind
      : row.subjectKind?.startsWith(`${row.plugin}:`)
        ? row.subjectKind.slice(row.plugin.length + 1)
        : undefined;
  return {
    ...parsed.data,
    ...(parsed.data.kind === "object" && ownKind && row.subjectId
      ? { subject: { id: row.subjectId, kind: ownKind } }
      : undefined),
    plugin: row.plugin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Add or replace one annotation of a plugin, and mark the Conversation detail
 * changed in the same statement. Pass a transaction to save it with other
 * changes. `subject` overrides the subject of the annotation, such as for an
 * attached link. Without a subject or an `action`, the database fills them
 * from the saved JSON. A later change keeps `created`: the Conversation
 * still created the object.
 */
export async function upsertPluginAnnotation(
  db: JuniorDatabase,
  args: {
    action?: AnnotationAction | undefined;
    annotation: ConversationAnnotationInput;
    conversationId: string;
    plugin: string;
    subject?: InboxItemSubject | undefined;
  },
): Promise<void> {
  const parsed = conversationAnnotationInputSchema.parse(args.annotation);
  const subject = args.subject ?? annotationSubject(args.plugin, parsed);
  // The columns hold the subject, so the JSON does not repeat it.
  const annotation =
    parsed.kind === "object" ? { ...parsed, subject: undefined } : parsed;
  const now = new Date();
  const table = juniorConversationAnnotations;
  await db
    .with(conversationDetailTouch(db, [args.conversationId]))
    .insert(table)
    .values({
      action: args.action,
      annotation,
      conversationId: args.conversationId,
      createdAt: now,
      key: annotation.key,
      kind: annotation.kind,
      plugin: args.plugin,
      subjectId: subject?.id,
      subjectKind: subject?.kind,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [table.conversationId, table.plugin, table.kind, table.key],
      set: {
        annotation,
        updatedAt: now,
        ...(subject
          ? { subjectId: subject.id, subjectKind: subject.kind }
          : undefined),
        ...(args.action
          ? {
              action: sql`case when ${table.action} = 'created' then 'created' else ${args.action} end`,
            }
          : undefined),
      },
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
    // Filter both ids on the joined Conversation row. An OR across the two
    // tables cannot use an index and scans both tables.
    .where(
      or(
        inArray(juniorConversations.conversationId, [...requested]),
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
