import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  SpaceActorKind,
  SpaceChangeKind,
  SpaceStatus,
} from "@/chat/spaces/types";
import { juniorConversations } from "./conversations";
import { timestamptz } from "./timestamps";

/**
 * Current Space tree. A Space points only at its parent, so moving a Space
 * moves its whole subtree and every assigned Conversation with one update.
 */
export const juniorSpaces = pgTable(
  "junior_spaces",
  {
    spaceId: text("space_id").primaryKey(),
    parentSpaceId: text("parent_space_id").references(
      (): AnyPgColumn => juniorSpaces.spaceId,
    ),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<SpaceStatus>().notNull().default("active"),
    mergedIntoSpaceId: text("merged_into_space_id").references(
      (): AnyPgColumn => juniorSpaces.spaceId,
    ),
    createdBy: text("created_by").$type<SpaceActorKind>().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("junior_spaces_parent_idx").on(table.parentSpaceId),
    uniqueIndex("junior_spaces_active_sibling_name_idx")
      .on(sql`coalesce(${table.parentSpaceId}, '')`, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
  ],
);

/** Current primary Space of one root Conversation. */
export const juniorConversationSpaces = pgTable(
  "junior_conversation_spaces",
  {
    conversationId: text("conversation_id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => juniorSpaces.spaceId),
    assignedBy: text("assigned_by").$type<SpaceActorKind>().notNull(),
    confidence: doublePrecision("confidence"),
    /** A pinned assignment came from a request. The classifier never replaces it. */
    pinned: boolean("pinned").notNull().default(false),
    turnId: text("turn_id"),
    assignedAt: timestamptz("assigned_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "junior_conversation_spaces_conversation_id_fk",
      columns: [table.conversationId],
      foreignColumns: [juniorConversations.conversationId],
    }).onDelete("cascade"),
    index("junior_conversation_spaces_space_idx").on(table.spaceId),
  ],
);

/**
 * Append-only log of Space structure changes and Conversation assignments.
 * Rows keep ids, names, and descriptions. Reasons are kept only for public
 * Conversations, so private content never lands here.
 */
export const juniorSpaceChanges = pgTable(
  "junior_space_changes",
  {
    changeId: text("change_id").primaryKey(),
    kind: text("kind").$type<SpaceChangeKind>().notNull(),
    spaceId: text("space_id").notNull(),
    conversationId: text("conversation_id"),
    actorKind: text("actor_kind").$type<SpaceActorKind>().notNull(),
    /** Conversation where the change was requested, when known. */
    actorConversationId: text("actor_conversation_id"),
    reason: text("reason"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("junior_space_changes_space_idx").on(
      table.spaceId,
      table.createdAt.desc(),
    ),
    index("junior_space_changes_conversation_idx").on(table.conversationId),
  ],
);
