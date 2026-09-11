import { and, eq, gt, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { pluginBriefSchema, type PluginBrief } from "@sentry/junior-plugin-api";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversationBriefs,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import { conversationBriefSchema } from "./schema";
import type { ConversationBriefSearchScope } from "./search";

/** Read the latest Briefs for authorized public root Conversations. */
export async function readPublicBriefsForPlugins(
  db: JuniorDatabase,
  args: {
    conversationIds: readonly string[];
    currentConversationId?: string;
    scope: ConversationBriefSearchScope;
  },
): Promise<Record<string, PluginBrief>> {
  const conversationIds = [...new Set(args.conversationIds)];
  if (conversationIds.length === 0) {
    return {};
  }

  const newer = alias(juniorConversationBriefs, "newer_plugin_briefs");
  const conditions = [
    inArray(juniorConversationBriefs.conversationId, conversationIds),
    notExists(
      db
        .select({ one: sql`1` })
        .from(newer)
        .where(
          and(
            eq(newer.conversationId, juniorConversationBriefs.conversationId),
            gt(newer.version, juniorConversationBriefs.version),
          ),
        ),
    ),
    isNull(juniorConversations.parentConversationId),
    eq(juniorDestinations.visibility, "public"),
    ...(args.currentConversationId
      ? [ne(juniorConversations.conversationId, args.currentConversationId)]
      : []),
  ];
  if (args.scope.kind === "public_provider_tenant") {
    conditions.push(
      eq(juniorConversations.source, args.scope.provider),
      eq(juniorDestinations.provider, args.scope.provider),
      eq(juniorDestinations.providerTenantId, args.scope.providerTenantId),
    );
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
    .where(and(...conditions));

  const briefs: Record<string, PluginBrief> = {};
  for (const row of rows) {
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
