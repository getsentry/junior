import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { slackAttachmentsVersionQuery } from "@/chat/slack/attachments";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";
import { JUNIOR_VERSION } from "@/version";
import type { ConversationAccess, ConversationAccessReader } from "./access";
import { readConversationAgentTree } from "./agent-tree";
import { readConversationForks } from "./fork";
import {
  viewerMarksFromParticipant,
  type ConversationViewerMarks,
} from "./membership";
import { conversationReadPositionQuery } from "./read-position";
import type { ConversationReadPosition } from "../schema/conversation-read-position";

const detailConversation = alias(juniorConversations, "detail_conversation");
const forkSource = alias(juniorConversations, "detail_fork_source");
const fork = alias(juniorConversations, "detail_fork");

/**
 * Sum the detail versions of a Conversation and its child agents. Child
 * writes bump only their own row, and the row count changes when a child
 * starts, so the parent needs no bump of its own.
 */
function subtreeDetailVersion(conversationId: string) {
  return getDb()
    .select({
      conversations: sql<number>`count(*)::int`.as("conversations"),
      version:
        sql<string>`coalesce(sum(${juniorConversations.detailVersion}), 0)::text`.as(
          "version",
        ),
    })
    .from(juniorConversations)
    .innerJoin(
      conversationSubtree([conversationId]),
      eq(
        conversationSubtreeColumns.conversationId,
        juniorConversations.conversationId,
      ),
    )
    .as("detail_subtree");
}

/**
 * Read the stored rows that the detail state needs in one query. A detail
 * request reads this beside access on every poll, so separate reads would
 * each hold a pool connection and add rounds. Returns undefined for a
 * missing Conversation.
 */
async function readDetailStateRow(conversationId: string, viewer?: User) {
  const db = getDb();
  const subtree = subtreeDetailVersion(conversationId);
  const rootConversationId = sql`coalesce(${detailConversation.rootConversationId}, ${detailConversation.conversationId})`;
  const forkIds = db
    .select({ conversationId: fork.conversationId })
    .from(fork)
    .where(
      and(
        eq(fork.forkedFromConversationId, conversationId),
        isNull(fork.quickQuestionAt),
      ),
    )
    .orderBy(asc(fork.createdAt))
    .limit(50);
  // Marks and the auto-archive choice live on the root.
  const viewerParticipant = viewer
    ? and(
        eq(juniorConversationParticipants.userId, viewer.id),
        eq(
          juniorConversationParticipants.rootConversationId,
          rootConversationId,
        ),
      )
    : sql`false`;
  const [row] = await db
    .select({
      archivedAt: juniorConversationParticipants.archivedAt,
      attachmentsVersion: sql<string>`(${slackAttachmentsVersionQuery(db, conversationId)})`,
      autoArchive: juniorConversationParticipants.autoArchive,
      autoArchiveDefault: juniorUsers.autoArchiveDefault,
      forkIds: sql<string[]>`array${forkIds}`,
      forkSourceId: forkSource.conversationId,
      forkSourceTitle: forkSource.title,
      lastReadSeq: viewer
        ? sql<
            number | null
          >`(${conversationReadPositionQuery(viewer, conversationId)})`
        : sql<null>`null`,
      parentConversationId: detailConversation.parentConversationId,
      pinnedAt: juniorConversationParticipants.pinnedAt,
      pinPosition: juniorConversationParticipants.pinPosition,
      subtreeConversations: subtree.conversations,
      subtreeVersion: subtree.version,
    })
    .from(detailConversation)
    .crossJoin(subtree)
    .leftJoin(
      forkSource,
      eq(
        forkSource.conversationId,
        detailConversation.forkedFromConversationId,
      ),
    )
    .leftJoin(juniorConversationParticipants, viewerParticipant)
    .leftJoin(juniorUsers, viewer ? eq(juniorUsers.id, viewer.id) : sql`false`)
    .where(eq(detailConversation.conversationId, conversationId));
  return row;
}

/**
 * Viewer state (access, marks, read position, auto-archive choice) and data
 * that other Conversations own (forks, agent tree labels).
 */
export type ConversationDetailState = {
  access?: ConversationAccess;
  agentTree?: Awaited<ReturnType<typeof readConversationAgentTree>>;
  autoArchive?: boolean;
  forks: Awaited<ReturnType<typeof readConversationForks>>;
  readPosition?: ConversationReadPosition;
  /**
   * Changes when events that a reader already has may project differently,
   * so an `appendCursor` from before it cannot extend them.
   */
  transcriptVersion: string;
  viewerMarks?: ConversationViewerMarks;
};

async function readDetailState(
  conversationId: string,
  viewer: User | undefined,
  readAccess: ConversationAccessReader,
): Promise<{
  state: ConversationDetailState;
  subtree: { conversations: number; version: string };
}> {
  const rowRead = readDetailStateRow(conversationId, viewer);
  const [accessById, row, forks, agentTree] = await Promise.all([
    readAccess([conversationId]),
    rowRead,
    rowRead.then((stored) =>
      readConversationForks(
        conversationId,
        {
          forkIds: stored?.forkIds ?? [],
          ...(stored?.forkSourceId
            ? {
                forkedFrom: {
                  conversationId: stored.forkSourceId,
                  title: stored.forkSourceTitle,
                },
              }
            : undefined),
          isChild: Boolean(stored?.parentConversationId),
        },
        readAccess,
      ),
    ),
    rowRead.then((stored) =>
      readConversationAgentTree(
        {
          conversationId,
          ...(stored?.parentConversationId
            ? { parentConversationId: stored.parentConversationId }
            : undefined),
        },
        readAccess,
      ),
    ),
  ]);
  const access = accessById.get(conversationId);
  // Stored events only grow. Their projection changes with the viewer's
  // access, the projection code, and the Slack files matched to messages.
  // Mentions and names are not covered: they refresh with a reload.
  const transcriptVersion = createHash("sha256")
    .update(
      JSON.stringify({
        attachments: row?.attachmentsVersion ?? "",
        canViewPrivateContent: access?.canViewPrivateContent ?? false,
        junior: JUNIOR_VERSION,
      }),
    )
    .digest("base64url");
  const viewerMarks = row ? viewerMarksFromParticipant(row) : undefined;
  return {
    state: {
      access,
      agentTree,
      // The viewer's choice for the root, else their default.
      ...(viewer
        ? { autoArchive: row?.autoArchive ?? row?.autoArchiveDefault ?? false }
        : undefined),
      forks,
      ...(row?.lastReadSeq != null
        ? { readPosition: { lastReadSeq: row.lastReadSeq } }
        : undefined),
      transcriptVersion,
      ...(viewerMarks ? { viewerMarks } : undefined),
    },
    subtree: {
      conversations: row?.subtreeConversations ?? 0,
      version: row?.subtreeVersion ?? "0",
    },
  };
}

/** Read the detail state that the ETag hashes and the report shows. */
export async function readConversationDetailState(
  conversationId: string,
  viewer: User | undefined,
  readAccess: ConversationAccessReader,
): Promise<ConversationDetailState> {
  return (await readDetailState(conversationId, viewer, readAccess)).state;
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
 *
 * The read position is not hashed. The dashboard writes it as the reader
 * scrolls and puts the stored value in its cached detail, so a poll after a
 * read can answer 304. Other tabs and devices get it with the next detail
 * change or a reload.
 */
export async function readConversationDetailEtag(
  conversationId: string,
  options: {
    limit?: number;
    readAccess: ConversationAccessReader;
    viewer?: User;
  },
): Promise<{ etag: string; state: ConversationDetailState } | undefined> {
  const { state, subtree } = await readDetailState(
    conversationId,
    options.viewer,
    options.readAccess,
  );
  if (subtree.conversations === 0) return undefined;
  const basis = JSON.stringify({
    access: state.access ?? null,
    agentTree: state.agentTree ?? null,
    autoArchive: state.autoArchive ?? null,
    forks: state.forks,
    junior: JUNIOR_VERSION,
    limit: options.limit ?? null,
    subtree,
    viewerMarks: state.viewerMarks ?? null,
  });
  return { etag: createHash("sha256").update(basis).digest("hex"), state };
}
