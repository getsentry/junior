import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * Who can read a Space. Anyone in the organization can find, read, and join a
 * public Space. Only the members of a private Space can read it.
 */
export type SpaceVisibility = "private" | "public";

/**
 * One Space: a named home for a body of related work (`design/spaces.md`).
 * Every root in a Space stores the Space's visibility on its own Location, so
 * the usual Conversation rules apply to it.
 */
export const juniorSpaces = pgTable(
  "junior_spaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility")
      .$type<SpaceVisibility>()
      .notNull()
      .default("public"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => juniorUsers.id),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    // Archive applies to everyone. Lists hide an archived Space.
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    index("junior_spaces_updated_idx").on(table.updatedAt.desc(), table.id),
  ],
);

/**
 * The members of a Space before they became the Participants of its Lead.
 * Nothing reads or writes it. Drop it once a release that does not use it
 * is live.
 */
export const juniorSpaceMembers = pgTable(
  "junior_space_members",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => juniorSpaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => juniorUsers.id),
    joinedAt: timestamptz("joined_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_space_members_space_user_pk",
      columns: [table.spaceId, table.userId],
    }),
    index("junior_space_members_user_idx").on(table.userId),
  ],
);

/**
 * One configuration value of a Space, such as a default repository. It
 * applies to every Conversation in the Space, before the Slack channel's
 * value and the install default.
 */
export const juniorSpaceConfigurations = pgTable(
  "junior_space_configurations",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => juniorSpaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // JSON text, like `junior_location_configurations.value`.
    value: text("value").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    updatedByUserId: text("updated_by_user_id").references(
      () => juniorUsers.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    primaryKey({
      name: "junior_space_configurations_space_key_pk",
      columns: [table.spaceId, table.key],
    }),
  ],
);
