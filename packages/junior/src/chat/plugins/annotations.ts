import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as z from "zod";
import {
  conversationAnnotationInputSchema,
  objectSubjectSchema,
  type AnnotationAction,
  type AnnotationPrefix,
  type ConversationAnnotation,
  type ConversationAnnotationInput,
  type ObjectSubject,
  type PluginAnnotations,
  type PluginConversationAnnotations,
  type UnnamedAnnotation,
} from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationAnnotations,
  juniorConversations,
} from "@/db/schema";
import type { StoredAnnotationJson } from "@/db/schema/conversation-annotations";
import {
  conversationDetailTouch,
  nextDetailVersion,
  touchConversationDetail,
} from "@/chat/conversations/sql/detail-version";
import {
  INBOX_SUBJECT_KINDS,
  pluginSubjectKind,
  type InboxItemSubject,
} from "@/chat/inbox-items/subjects";

const table = juniorConversationAnnotations;
const otherRow = alias(juniorConversationAnnotations, "other_annotation");

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

// The JSON holds the shape and the type of the object. A row that an older
// release saved can also hold `objectId`, which no reader uses.
const savedAnnotationJsonSchema = z.looseObject({
  key: z.string(),
  kind: z.enum(["object", "resource_link"]),
  objectType: z.unknown().optional(),
});

function annotationFromRow(row: {
  annotation: unknown;
  conversationId: string;
  createdAt: Date;
  plugin: string;
  subjectId: string | null;
  subjectKind: string | null;
  title: string | null;
  updatedAt: Date;
  url: string | null;
}): ConversationAnnotation | undefined {
  const saved = savedAnnotationJsonSchema.safeParse(row.annotation);
  if (!saved.success) return undefined;
  const { key, kind, objectType } = saved.data;
  const parsed = conversationAnnotationInputSchema.safeParse(
    kind === "object"
      ? { key, kind, objectType, title: row.title, url: row.url }
      : { key, kind, objectType, url: row.url },
  );
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
  // The columns hold the subject, the title, and the link.
  const annotation: StoredAnnotationJson = {
    key: parsed.key,
    kind: parsed.kind,
    ...(parsed.objectType ? { objectType: parsed.objectType } : undefined),
  };
  const title = parsed.kind === "object" ? parsed.title : null;
  const now = new Date();
  if (subject) {
    await rekeyBySubject(
      db,
      {
        conversationId: args.conversationId,
        key: parsed.key,
        kind: parsed.kind,
        plugin: args.plugin,
      },
      subject,
    );
  }
  await db
    .with(conversationDetailTouch(db, [args.conversationId]))
    .insert(table)
    .values({
      action: args.action,
      annotation,
      conversationId: args.conversationId,
      createdAt: now,
      key: parsed.key,
      kind: parsed.kind,
      plugin: args.plugin,
      subjectId: subject?.id,
      subjectKind: subject?.kind,
      title,
      updatedAt: now,
      url: parsed.url,
    })
    .onConflictDoUpdate({
      target: [table.conversationId, table.plugin, table.kind, table.key],
      set: {
        annotation,
        title,
        updatedAt: now,
        url: parsed.url,
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

// A move at the provider, such as a repository rename, changes the key of
// an object but not its subject. Give the Annotation that names the object
// in this Conversation the new key, so that the upsert changes it and adds
// no second Annotation. It keeps its key when the new key is taken.
async function rekeyBySubject(
  db: JuniorDatabase,
  target: { conversationId: string; key: string; kind: string; plugin: string },
  subject: InboxItemSubject,
): Promise<void> {
  await db
    .update(table)
    .set({ key: target.key })
    .where(
      and(
        eq(table.conversationId, target.conversationId),
        eq(table.plugin, target.plugin),
        eq(table.kind, target.kind),
        eq(
          table.key,
          db
            .select({ key: otherRow.key })
            .from(otherRow)
            .where(
              and(
                eq(otherRow.conversationId, target.conversationId),
                eq(otherRow.plugin, target.plugin),
                eq(otherRow.kind, target.kind),
                eq(otherRow.subjectKind, subject.kind),
                eq(otherRow.subjectId, subject.id),
                ne(otherRow.key, target.key),
              ),
            )
            .orderBy(asc(otherRow.createdAt))
            .limit(1),
        ),
        notExists(
          db
            .select({ key: otherRow.key })
            .from(otherRow)
            .where(
              and(
                eq(otherRow.conversationId, target.conversationId),
                eq(otherRow.plugin, target.plugin),
                eq(otherRow.kind, target.kind),
                eq(otherRow.key, target.key),
              ),
            ),
        ),
      ),
    );
}

/**
 * Mark each Conversation that annotates one object of a plugin as changed,
 * so its detail and its row read the live card again. Writes no Annotation.
 */
export async function touchAnnotatedConversations(
  db: JuniorDatabase,
  plugin: string,
  subject: ObjectSubject,
): Promise<void> {
  await db
    .update(juniorConversations)
    .set({ detailVersion: nextDetailVersion })
    .where(
      inArray(
        juniorConversations.conversationId,
        db
          .select({ conversationId: table.conversationId })
          .from(table)
          .where(
            and(
              eq(table.subjectKind, pluginSubjectKind(plugin, subject.kind)),
              eq(table.subjectId, subject.id),
            ),
          ),
      ),
    );
}

// Plugin writes that repair the stored names of objects across
// Conversations: the provider id that an old row lacks, and the keys and
// links of objects that the provider moved. The plugin reads the provider,
// and core owns the rows (`policies/provider-boundaries.md`).

// List the keys of a plugin's Annotations whose subject is only a link.
async function listUnnamedAnnotations(
  db: JuniorDatabase,
  plugin: string,
  input: { after?: string | undefined; limit: number },
): Promise<UnnamedAnnotation[]> {
  const limit = z.number().int().positive().max(500).parse(input.limit);
  return await db
    .select({ key: table.key, url: sql<string | null>`max(${table.url})` })
    .from(table)
    .where(
      and(
        eq(table.subjectKind, ANNOTATION_SUBJECT_KINDS.link),
        eq(table.plugin, plugin),
        input.after === undefined ? undefined : gt(table.key, input.after),
      ),
    )
    .groupBy(table.key)
    .orderBy(asc(table.key))
    .limit(limit);
}

/**
 * Give each Annotation of a plugin with this key and only a link subject
 * the object's subject and current link. Its update time stays, so the
 * Annotation keeps its place in the Conversation.
 */
async function nameAnnotationObject(
  db: JuniorDatabase,
  plugin: string,
  key: string,
  object: { subject: ObjectSubject; url: string },
): Promise<void> {
  const subject = objectSubjectSchema.parse(object.subject);
  const url = z.url().max(2048).parse(object.url);
  await db.transaction(async (tx) => {
    const named = await tx
      .update(table)
      .set({
        subjectId: subject.id,
        subjectKind: pluginSubjectKind(plugin, subject.kind),
        url,
      })
      .where(
        and(
          eq(table.subjectKind, ANNOTATION_SUBJECT_KINDS.link),
          eq(table.plugin, plugin),
          eq(table.key, key),
        ),
      )
      .returning({ conversationId: table.conversationId });
    await touchConversationDetail(tx, [
      ...new Set(named.map((row) => row.conversationId)),
    ]);
  });
}

/**
 * Replace the key prefix and the link prefix of a plugin's moved objects.
 * A key moves only when its Conversation has no Annotation of the same
 * kind with the new key, so the primary key holds.
 */
async function moveAnnotationObjects(
  db: JuniorDatabase,
  plugin: string,
  move: { from: AnnotationPrefix; to: AnnotationPrefix },
): Promise<void> {
  const { from, to } = move;
  const movedKey = sql`${to.key}::text || substr(${table.key}, length(${from.key}::text) + 1)`;
  const keyMatches = sql`starts_with(${table.key}, ${from.key}::text)`;
  const urlMatches = sql`lower(left(${table.url}, length(${from.url}::text))) = ${from.url.toLowerCase()}::text`;
  const keyMoves = and(
    keyMatches,
    notExists(
      db
        .select({ key: otherRow.key })
        .from(otherRow)
        .where(
          and(
            eq(otherRow.conversationId, table.conversationId),
            eq(otherRow.plugin, table.plugin),
            eq(otherRow.kind, table.kind),
            eq(otherRow.key, movedKey),
          ),
        ),
    ),
  );
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(table)
      .set({
        key: sql`case when ${keyMoves} then ${movedKey} else ${table.key} end`,
        // The saved Annotation names its key too, and lists read it there.
        annotation: sql`case when ${keyMoves} then jsonb_set(${table.annotation}, '{key}', to_jsonb(${movedKey})) else ${table.annotation} end`,
        url: sql`case when ${urlMatches} then ${to.url}::text || substr(${table.url}, length(${from.url}::text) + 1) else ${table.url} end`,
      })
      .where(and(eq(table.plugin, plugin), or(keyMatches, urlMatches)))
      .returning({ conversationId: table.conversationId });
    await touchConversationDetail(tx, [
      ...new Set(moved.map((row) => row.conversationId)),
    ]);
  });
}

/** Create the Annotations capability of one plugin. */
export function createPluginConversationAnnotations(args: {
  db: () => JuniorDatabase;
  plugin: string;
}): PluginConversationAnnotations {
  return {
    forConversation: (conversationId) =>
      createPluginAnnotations({
        conversationId,
        db: args.db(),
        plugin: args.plugin,
      }),
    listUnnamed: async (input) =>
      await listUnnamedAnnotations(args.db(), args.plugin, input),
    nameObject: async (key, object) =>
      await nameAnnotationObject(args.db(), args.plugin, key, object),
    objectsMoved: async (move) =>
      await moveAnnotationObjects(args.db(), args.plugin, move),
    objectChanged: async (subject) =>
      await touchAnnotatedConversations(args.db(), args.plugin, subject),
  };
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
