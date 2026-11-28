import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { juniorUsers } from "./users";
import { timestamptz } from "./timestamps";

/**
 * One Space: a named home for a body of related work (`design/spaces.md`).
 * Its Lead holds its name, visibility, and archive: the Lead's title,
 * visibility, and archive time. Every Conversation in the Space is in the
 * Lead's tree, so the usual Conversation rules apply to it.
 */
export const juniorSpaces = pgTable(
  "junior_spaces",
  {
    id: text("id").primaryKey(),
    description: text("description"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => juniorUsers.id),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    index("junior_spaces_updated_idx").on(table.updatedAt.desc(), table.id),
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
