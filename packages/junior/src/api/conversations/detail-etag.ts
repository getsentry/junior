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
import {
  readConversationAccessFromSql,
  type ConversationAccess,
} from "./access";
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
 * Viewer state (access, marks, read position, auto-archive choice) and data
 * that other Conversations own (forks, agent tree labels).
 */
export type ConversationDetailState = {
  access?: ConversationAccess;
  agentTree?: Awaited<ReturnType<typeof readConversationAgentTree>>;
  autoArchive?: Awaited<ReturnType<typeof readConversationAutoArchive>>;
  forks: Awaited<ReturnType<typeof readConversationForks>>;
  readPosition?: Awaited<ReturnType<typeof readConversationReadPosition>>;
  viewerMarks?: Awaited<ReturnType<typeof readConversationViewerMarks>>;
};

/** Read the detail state that the ETag hashes and the report shows. */
export async function readConversationDetailState(
  conversationId: string,
  viewer?: User,
): Promise<ConversationDetailState> {
  const [access, viewerMarks, forks, agentTree, readPosition, autoArchive] =
    await Promise.all([
      readConversationAccessFromSql(getDb(), [conversationId], viewer),
      viewer ? readConversationViewerMarks(viewer, conversationId) : undefined,
      readConversationForks(conversationId, viewer),
      readConversationAgentTree(conversationId, viewer),
      viewer ? readConversationReadPosition(viewer, conversationId) : undefined,
      viewer ? readConversationAutoArchive(viewer, conversationId) : undefined,
    ]);
  return {
    access: access.get(conversationId),
    agentTree,
    autoArchive,
    forks,
    readPosition,
    viewerMarks,
  };
}

/**
 * Return the detail ETag without building the report, or undefined for a
 * missing Conversation. The state comes back too, so the report reuses it
 * and matches the ETag.
 *
 * Shared content is covered by `detail_version`. The detail state is cheap,
 * so it is read on each request. Names, avatars, Automation titles, and
 * plugin sidebar labels are not covered: they refresh with the next detail
 * change or a reload.
 */
export async function readConversationDetailEtag(
  conversationId: string,
  options: { limit: number; viewer?: User },
): Promise<{ etag: string; state: ConversationDetailState } | undefined> {
  const [subtree, state] = await Promise.all([
    readSubtreeDetailVersion(conversationId),
    readConversationDetailState(conversationId, options.viewer),
  ]);
  if (subtree.conversations === 0) return undefined;
  const basis = JSON.stringify({
    access: state.access ?? null,
    agentTree: state.agentTree ?? null,
    autoArchive: state.autoArchive ?? null,
    forks: state.forks,
    junior: JUNIOR_VERSION,
    limit: options.limit,
    readPosition: state.readPosition ?? null,
    subtree,
    viewerMarks: state.viewerMarks ?? null,
  });
  return { etag: createHash("sha256").update(basis).digest("hex"), state };
}
