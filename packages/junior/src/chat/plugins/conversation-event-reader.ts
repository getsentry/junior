import type {
  PluginConversationEventReader,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { and, desc, eq, sql } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { juniorConversationEvents } from "@/db/schema";

function registeredEventName(
  plugin: PluginRegistration,
  eventName: string,
): string {
  if (
    !plugin.conversationEvents?.some(
      (definition) => definition.eventName === eventName,
    )
  ) {
    throw new TypeError(
      `Plugin "${plugin.manifest.name}" did not register event "${eventName}"`,
    );
  }
  return eventName;
}

/** Create Conversation event reads bound to one plugin namespace. */
export function createPluginConversationEventReader(
  plugin: PluginRegistration,
): PluginConversationEventReader {
  return {
    async list(input) {
      const eventName = registeredEventName(plugin, input.eventName);
      const db = getDb();
      const access = (
        await readConversationAccessFromSql(
          db,
          [input.conversationId],
          input.viewer,
        )
      ).get(input.conversationId);
      if (!access?.canViewPrivateContent) return undefined;

      const rows = await db
        .select({
          content: sql<
            Record<string, unknown>
          >`${juniorConversationEvents.payload}->'content'`,
          createdAt: juniorConversationEvents.createdAt,
          version: sql<number>`(${juniorConversationEvents.payload}->>'version')::integer`,
        })
        .from(juniorConversationEvents)
        .where(
          and(
            eq(juniorConversationEvents.conversationId, input.conversationId),
            eq(juniorConversationEvents.type, "structured_event"),
            sql`${juniorConversationEvents.payload}->>'namespace' = ${plugin.manifest.name}`,
            sql`${juniorConversationEvents.payload}->>'name' = ${eventName}`,
          ),
        )
        .orderBy(desc(juniorConversationEvents.seq));
      return rows.map((row) => ({
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        version: row.version,
      }));
    },
  };
}
