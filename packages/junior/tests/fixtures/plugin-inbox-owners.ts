import { sql } from "drizzle-orm";
import type {
  PluginInboxItems,
  PluginInboxSubjectOwner,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginInboxItems } from "@/chat/inbox-items/plugin";

/**
 * The owner table of test plugins' items. A real plugin maps a subject id
 * to its Conversation in its own table, such as GitHub's opener rows.
 */
export const TEST_PLUGIN_INBOX_OWNER: PluginInboxSubjectOwner = {
  conversationId: "conversation_id",
  subjectId: "subject_id",
  table: "test_plugin_inbox_owners",
};

/** Map one test plugin subject id to the Conversation that owns its item. */
export async function ownTestPluginSubject(
  subjectId: string,
  conversationId: string,
): Promise<void> {
  // The test template has the table (`postgres/global-setup.ts`).
  await getDb().execute(
    sql`insert into test_plugin_inbox_owners (subject_id, conversation_id) values (${subjectId}, ${conversationId}) on conflict (subject_id) do update set conversation_id = excluded.conversation_id`,
  );
}

/**
 * Plugin Inbox items of a test plugin, as `createPluginInboxItems` makes
 * them. Each upsert first maps its subject to the Conversation, as a
 * plugin records the owner before it adds the item.
 */
export function ownedPluginInboxItems(
  args: Parameters<typeof createPluginInboxItems>[0],
): PluginInboxItems {
  const items = createPluginInboxItems(args);
  return {
    ...items,
    async upsert(notice) {
      await ownTestPluginSubject(notice.subject.id, args.conversationId);
      await items.upsert(notice);
    },
  };
}
