import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
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
import { readUnreadConversationIds } from "./unread";
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

const versionConversation = alias(juniorConversations, "version_conversation");
const versionFork = alias(juniorConversations, "version_fork");
const versionParticipant = alias(
  juniorConversationParticipants,
  "version_participant",
);
const versionUser = alias(juniorUsers, "version_user");

/**
 * Hash the detail state whose writes do not bump `detail_version`: the
 * viewer's marks and auto-archive choice on the root, the forks, and the
 * matched Slack files. Each part is a lookup by key, so the versions poll
 * stays one cheap statement.
 */
function viewerStateVersion(
  db: JuniorDatabase,
  conversationId: string,
  viewerId: string,
) {
  const root = db
    .select({
      id: sql<string>`coalesce(${versionConversation.rootConversationId}, ${versionConversation.conversationId})`,
    })
    .from(versionConversation)
    .where(eq(versionConversation.conversationId, conversationId));
  const participant = db
    .select({
      state: sql<string>`row(${versionParticipant.pinnedAt}, ${versionParticipant.pinPosition}, ${versionParticipant.autoArchive})::text`,
    })
    .from(versionParticipant)
    .where(
      and(
        eq(versionParticipant.userId, viewerId),
        eq(versionParticipant.rootConversationId, sql`(${root})`),
      ),
    );
  const autoArchiveDefault = db
    .select({ value: versionUser.autoArchiveDefault })
    .from(versionUser)
    .where(eq(versionUser.id, viewerId));
  const forks = db
    .select({
      ids: sql<string>`string_agg(${versionFork.conversationId}, ',' order by ${versionFork.conversationId})`,
    })
    .from(versionFork)
    .where(
      and(
        eq(versionFork.forkedFromConversationId, conversationId),
        isNull(versionFork.quickQuestionAt),
      ),
    );
  // A missing part keeps its place, so two different states cannot hash
  // the same.
  return sql<string>`md5(concat_ws('|',
    coalesce((${participant}), ''),
    coalesce((${autoArchiveDefault})::text, ''),
    coalesce((${forks}), ''),
    (${slackAttachmentsVersionQuery(db, conversationId)})
  ))`;
}

/**
 * Return a query for the change token of a Conversation and its child
 * agents, as the viewer sees it, or a null token when it is missing. The
 * detail report sends the same token, so the dashboard can find a stale
 * detail without asking for the report.
 */
export function conversationVersionQuery(
  db: JuniorDatabase,
  conversationId: string,
  viewerId: string | undefined,
) {
  const subtree = subtreeDetailVersion(conversationId);
  const viewerState = viewerId
    ? viewerStateVersion(db, conversationId, viewerId)
    : sql`null`;
  return db
    .select({
      version: sql<
        string | null
      >`case when ${subtree.conversations} = 0 then null else concat_ws(':', ${subtree.conversations}, ${subtree.version}, ${viewerState}) end`,
    })
    .from(subtree);
}

/**
 * Read the stored rows that the detail state needs in one query. A detail
 * request reads this beside access on every poll, so separate reads would
 * each hold a pool connection and add rounds. Returns undefined for a
 * missing Conversation.
 */
async function readDetailStateRow(conversationId: string, viewer?: User) {
  const db = getDb();
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
      rootConversationId: sql<string>`${rootConversationId}`,
      version: sql<
        string | null
      >`(${conversationVersionQuery(db, conversationId, viewer?.id)})`,
    })
    .from(detailConversation)
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
  /** The root has a visible Junior reply after the viewer's read position. */
  unreadReply?: boolean;
  viewerMarks?: ConversationViewerMarks;
};

async function readDetailState(
  conversationId: string,
  viewer: User | undefined,
  readAccess: ConversationAccessReader,
): Promise<{
  state: ConversationDetailState;
  /** `conversationVersionQuery` token, or undefined when missing. */
  version: string | undefined;
}> {
  const rowRead = readDetailStateRow(conversationId, viewer);
  const [accessById, row, forks, agentTree, unreadIds] = await Promise.all([
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
    // Unread belongs to the root, like the marks.
    rowRead.then((stored) =>
      viewer && stored
        ? readUnreadConversationIds(
            getDb(),
            [stored.rootConversationId],
            viewer.id,
          )
        : new Set<string>(),
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
      ...(viewer && row
        ? { unreadReply: unreadIds.has(row.rootConversationId) }
        : undefined),
      ...(viewerMarks ? { viewerMarks } : undefined),
    },
    version: row?.version ?? undefined,
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
): Promise<
  | {
      etag: string;
      state: ConversationDetailState;
      /** `conversationVersionQuery` token of the same read. */
      version: string;
    }
  | undefined
> {
  const { state, version } = await readDetailState(
    conversationId,
    options.viewer,
    options.readAccess,
  );
  if (!version) return undefined;
  const basis = JSON.stringify({
    access: state.access ?? null,
    agentTree: state.agentTree ?? null,
    autoArchive: state.autoArchive ?? null,
    forks: state.forks,
    junior: JUNIOR_VERSION,
    limit: options.limit ?? null,
    version,
    // The read position is not hashed, but whether it leaves a reply unread
    // is, so the next poll after a read or a mark shows the new state.
    unreadReply: state.unreadReply ?? false,
    viewerMarks: state.viewerMarks ?? null,
  });
  return {
    etag: createHash("sha256").update(basis).digest("hex"),
    state,
    version,
  };
}
