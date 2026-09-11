import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { pluginBriefSchema, type PluginBrief } from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { conversationBriefSchema } from "./schema";

/** Read the latest Briefs for authorized public root Conversations. */
export async function readPublicBriefsForPlugins(
  db: JuniorDatabase,
  args: {
    conversationIds: readonly string[];
    currentConversationId?: string;
  },
): Promise<Record<string, PluginBrief>> {
  const conversationIds = [...new Set(args.conversationIds)].filter(
    (conversationId) => conversationId !== args.currentConversationId,
  );
  if (conversationIds.length === 0) {
    return {};
  }

  const rows = await db
    .select({
      content: juniorConversationBriefs.content,
      conversationId: juniorConversationBriefs.conversationId,
      createdAt: juniorConversationBriefs.createdAt,
    })
    .from(juniorConversationBriefs)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationBriefs.conversationId,
      ),
    )
    .innerJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      and(
        inArray(juniorConversationBriefs.conversationId, conversationIds),
        isNull(juniorConversations.parentConversationId),
        eq(juniorDestinations.visibility, "public"),
        ...(args.currentConversationId
          ? [ne(juniorConversations.conversationId, args.currentConversationId)]
          : []),
      ),
    )
    .orderBy(
      desc(juniorConversationBriefs.version),
      desc(juniorConversationBriefs.createdAt),
    );

  const briefs: Record<string, PluginBrief> = {};
  for (const row of rows) {
    if (briefs[row.conversationId]) {
      continue;
    }
    const content = conversationBriefSchema.parse(row.content);
    briefs[row.conversationId] = pluginBriefSchema.parse({
      conversationId: row.conversationId,
      summary: content.summary,
      outcome: content.outcome,
      decisions: content.decisions.map(({ kind, text }) => ({ kind, text })),
      links: content.links.map(({ label, status, url }) => ({
        label,
        url,
        ...(status ? { status } : undefined),
      })),
      updatedAt: row.createdAt.toISOString(),
    });
  }
  return briefs;
}
