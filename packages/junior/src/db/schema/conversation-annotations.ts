import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import type { ConversationAnnotationInput } from "@sentry/junior-plugin-api";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";
export const juniorConversationAnnotations = pgTable(
  "junior_conversation_annotations",
  {
    conversationId: text("conversation_id").notNull(),
    plugin: text("plugin").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
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
    // Finds the Conversation that first saved an object, for the owner of
    // an Inbox item that names the object by its provider id.
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
