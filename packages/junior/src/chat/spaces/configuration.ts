/**
 * Configuration of a Space: the same keys that a Slack channel sets, such as
 * a default repository. A value applies to every Conversation in the Space.
 * It wins over the Slack channel's value and the install default, and an
 * explicit target in a request wins over it.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  configValueSchema,
  type ConfigValue,
} from "@/chat/configuration/types";
import {
  validateConfigKey,
  validateConfigValue,
} from "@/chat/configuration/validation";
import { getDb } from "@/chat/db";
import { juniorConversations, juniorSpaceConfigurations } from "@/db/schema";

const rootConversation = alias(juniorConversations, "space_config_root");

/** One configuration value of a Space. */
export interface SpaceConfigEntry {
  key: string;
  value: ConfigValue;
  updatedAt: Date;
}

/** List the configuration of a Space, by key. */
export async function listSpaceConfiguration(
  spaceId: string,
): Promise<SpaceConfigEntry[]> {
  const rows = await getDb()
    .select({
      key: juniorSpaceConfigurations.key,
      value: juniorSpaceConfigurations.value,
      updatedAt: juniorSpaceConfigurations.updatedAt,
    })
    .from(juniorSpaceConfigurations)
    .where(eq(juniorSpaceConfigurations.spaceId, spaceId))
    .orderBy(asc(juniorSpaceConfigurations.key));
  return rows.map((row) => ({
    ...row,
    value: configValueSchema.parse(JSON.parse(row.value)),
  }));
}

/**
 * Set one configuration value of a Space. Returns an error message when the
 * key or the value is not allowed, such as a secret.
 */
export async function setSpaceConfiguration(args: {
  key: string;
  spaceId: string;
  updatedByUserId: string;
  value: ConfigValue;
}): Promise<string | undefined> {
  const error = validateConfigKey(args.key) ?? validateConfigValue(args.value);
  if (error) return error;
  const values = {
    value: JSON.stringify(args.value),
    updatedAt: new Date(),
    updatedByUserId: args.updatedByUserId,
  };
  await getDb()
    .insert(juniorSpaceConfigurations)
    .values({ spaceId: args.spaceId, key: args.key, ...values })
    .onConflictDoUpdate({
      target: [
        juniorSpaceConfigurations.spaceId,
        juniorSpaceConfigurations.key,
      ],
      set: values,
    });
  return undefined;
}

/** Remove one configuration value of a Space. */
export async function unsetSpaceConfiguration(
  spaceId: string,
  key: string,
): Promise<void> {
  await getDb()
    .delete(juniorSpaceConfigurations)
    .where(
      and(
        eq(juniorSpaceConfigurations.spaceId, spaceId),
        eq(juniorSpaceConfigurations.key, key),
      ),
    );
}

/**
 * Return the configuration of the Space that a Conversation's root is in. A
 * child is in the Space of its root. A Conversation outside a Space has none.
 */
export async function readConversationSpaceConfiguration(
  conversationId: string,
): Promise<Record<string, ConfigValue>> {
  const rows = await getDb()
    .select({
      key: juniorSpaceConfigurations.key,
      value: juniorSpaceConfigurations.value,
    })
    .from(juniorConversations)
    .innerJoin(
      rootConversation,
      // An older root has no root id, so it matches by its own id.
      eq(
        rootConversation.conversationId,
        sql`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`,
      ),
    )
    .innerJoin(
      juniorSpaceConfigurations,
      eq(juniorSpaceConfigurations.spaceId, rootConversation.spaceId),
    )
    .where(eq(juniorConversations.conversationId, conversationId));
  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      configValueSchema.parse(JSON.parse(row.value)),
    ]),
  );
}
