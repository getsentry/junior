import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { juniorConversations } from "@/db/schema";
import { JUNIOR_VERSION } from "@/version";
import { readConversationAccessFromSql } from "./access";
import { readConversationAgentTree } from "./agent-tree";
import { readConversationAutoArchive } from "./auto-archive";
import { readConversationForks } from "./fork";
import { readConversationViewerMarks } from "./membership";
import { readConversationReadPosition } from "./read-position";

/**
 * Sum the detail versions of a Conversation and its child agents. Child
 * writes bump only their own row, and the row count changes when a child
 * starts, so the parent needs no bump of its own.
 */
async function readSubtreeDetailVersion(
  conversationId: string,
): Promise<{ conversations: number; version: string }> {
  const [row] = await getDb()
    .select({
      conversations: sql<number>`count(*)::int`,
      version: sql<string>`coalesce(sum(${juniorConversations.detailVersion}), 0)::text`,
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree([conversationId]),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversations.conversationId,
      ),
    );
  return row ?? { conversations: 0, version: "0" };
}

/**
 * Return the detail ETag without building the report, or undefined for a
 * missing Conversation.
 *
 * Shared content is covered by `detail_version`. Viewer state (marks, read
 * position, auto-archive choice) and data that other Conversations own (forks,
 * agent tree labels) are cheap, so they are read on each request. Names, avatars, Automation titles, and plugin sidebar
 * labels are not covered: they refresh with the next detail change or a reload.
 */
export async function readConversationDetailEtag(
  conversationId: string,
  options: { limit: number; viewer?: User },
): Promise<string | undefined> {
  const { viewer } = options;
  const [
    subtree,
    access,
    viewerMarks,
    forks,
    agentTree,
    readPosition,
    autoArchive,
  ] = await Promise.all([
    readSubtreeDetailVersion(conversationId),
    readConversationAccessFromSql(getDb(), [conversationId], viewer),
    viewer ? readConversationViewerMarks(viewer, conversationId) : undefined,
    readConversationForks(conversationId, viewer),
    readConversationAgentTree(conversationId, viewer),
    viewer ? readConversationReadPosition(viewer, conversationId) : undefined,
    viewer ? readConversationAutoArchive(viewer, conversationId) : undefined,
  ]);
  if (subtree.conversations === 0) return undefined;
  const basis = JSON.stringify({
    access: access.get(conversationId) ?? null,
    agentTree: agentTree ?? null,
    autoArchive: autoArchive ?? null,
    forks,
    junior: JUNIOR_VERSION,
    limit: options.limit,
    readPosition: readPosition ?? null,
    subtree,
    viewerMarks: viewerMarks ?? null,
  });
  return createHash("sha256").update(basis).digest("hex");
}
