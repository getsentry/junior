import type {
  PluginConversationEventReader,
  PluginConversationEventRecord,
  PluginRegistration,
  PluginTurnEventReader,
} from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
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

      return await listPluginEvents({
        filters: [
          eq(juniorConversationEvents.conversationId, input.conversationId),
        ],
        newestFirst: true,
        plugin,
        eventName,
      });
    },
  };
}

/**
 * Create event reads bound to one plugin namespace and one Turn. A plugin
 * task reads what the plugin emitted earlier in the Turn that it processes.
 */
export function createPluginTurnEventReader(args: {
  conversationId: string;
  plugin: PluginRegistration;
  turnId: string;
}): PluginTurnEventReader {
  return {
    async list(input) {
      return await listPluginEvents({
        eventName: registeredEventName(args.plugin, input.eventName),
        filters: [
          eq(juniorConversationEvents.conversationId, args.conversationId),
          sql`${juniorConversationEvents.payload}->>'turnId' = ${args.turnId}`,
        ],
        newestFirst: false,
        plugin: args.plugin,
      });
    },
  };
}

async function listPluginEvents(args: {
  eventName: string;
  filters: SQL[];
  newestFirst: boolean;
  plugin: PluginRegistration;
}): Promise<PluginConversationEventRecord[]> {
  const rows = await getDb()
    .select({
      content: sql<
        Record<string, unknown>
      >`${juniorConversationEvents.payload}->'content'`,
      createdAt: juniorConversationEvents.createdAt,
      seq: juniorConversationEvents.seq,
      turnId: sql<
        string | null
      >`${juniorConversationEvents.payload}->>'turnId'`,
      version: sql<number>`(${juniorConversationEvents.payload}->>'version')::integer`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        ...args.filters,
        eq(juniorConversationEvents.type, "structured_event"),
        sql`${juniorConversationEvents.payload}->>'namespace' = ${args.plugin.manifest.name}`,
        sql`${juniorConversationEvents.payload}->>'name' = ${args.eventName}`,
      ),
    )
    .orderBy(
      args.newestFirst
        ? desc(juniorConversationEvents.seq)
        : asc(juniorConversationEvents.seq),
    );
  return rows.map((row) => ({
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    seq: row.seq,
    ...(row.turnId ? { turnId: row.turnId } : undefined),
    version: row.version,
  }));
}
