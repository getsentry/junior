import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import type {
  AnnotationAction,
  ConversationAnnotationInput,
} from "@sentry/junior-plugin-api";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
export const juniorConversationAnnotations = pgTable(
  "junior_conversation_annotations",
  {
    conversationId: text("conversation_id").notNull(),
    plugin: text("plugin").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    // The object: a subject kind in the Inbox form, `<plugin>:<kind>` or a
    // core kind, and the provider's id of the object. Null only until the
    // trigger of `20261125135950_annotation_subjects` fills a row that an
    // old worker wrote.
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    action: text("action").$type<AnnotationAction>(),
    annotation: jsonb("annotation_json")
      .$type<ConversationAnnotationInput>()
      .notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_conversation_annotations_pk",
      columns: [table.conversationId, table.plugin, table.kind, table.key],
    }),
    foreignKey({
      name: "junior_conversation_annotations_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    // Finds the Conversations that point to one object, oldest first, such
    // as the owner of an Inbox item about the object.
    index("junior_conversation_annotations_subject_idx")
      .on(table.subjectKind, table.subjectId, table.createdAt)
      .where(sql`${table.subjectKind} is not null`),
    // The owner lookup of the last release, which read `objectId` from the
    // JSON. Old workers use it while this release rolls out.
    index("junior_conversation_annotations_object_id_idx")
      .on(
        table.plugin,
        sql`(${table.annotation} ->> 'objectId')`,
        table.createdAt,
      )
      .where(
        sql`${table.kind} = 'object' and (${table.annotation} ->> 'objectId') is not null`,
      ),
  ],
);
