import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
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
  juniorConversationReadPositions,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { JUNIOR_VERSION } from "@/version";
import type { ConversationAccess, ConversationAccessReader } from "./access";
import { readConversationForks } from "./fork";
import {
  viewerMarksFromParticipant,
  type ConversationViewerMarks,
} from "./membership";
import { conversationReadPositionQuery } from "./read-position";
import {
  conversationRecordColumns,
  conversationRecordFromRow,
  conversationRecordJoins,
  type ConversationRecord,
} from "./record";
import { unreadReplySql } from "./unread";
import type { ConversationReadPosition } from "../schema/conversation-read-position";

const detailViewer = alias(juniorUsers, "detail_viewer");
const forkSource = alias(juniorConversations, "detail_fork_source");
const fork = alias(juniorConversations, "detail_fork");
const agentTreeRoot = alias(juniorConversations, "detail_agent_tree_root");

/**
 * Return the root fields that label the agent tree of a child: its title and
 * channel name. The other labels cannot change once the child exists. An
 * agent invocation keeps its title and agent name after insert, and only the
 * spawn sets a title. Access to each node comes from the shared root, so the
 * viewer's access covers it. This keeps the recursive lineage read out of
 * every poll.
 */
function agentTreeRootLabel(db: JuniorDatabase, rootConversationId: SQL) {
  return db
    .select({
      label: sql<string>`row(${agentTreeRoot.title}, ${agentTreeRoot.channelName})::text`,
    })
    .from(agentTreeRoot)
    .where(eq(agentTreeRoot.conversationId, rootConversationId));
}

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
      state: sql<string>`row(${versionParticipant.pinnedAt}, ${versionParticipant.pinPosition}, ${versionParticipant.autoArchive}, ${versionParticipant.unsubscribedAt})::text`,
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
 * Read the record and the stored rows that the detail state needs in one
 * query. A detail request reads this beside access on every poll, so
 * separate reads would each hold a pool connection and add rounds. One
 * statement also reads one snapshot, so the record is never older than the
 * version token that the ETag hashes. Returns undefined for a missing
 * Conversation.
 */
async function readDetailStateRow(conversationId: string, viewer?: User) {
  const db = getDb();
  const rootConversationId = sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`;
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
  // Marks, the auto-archive choice, and unread live on the root.
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
      ...conversationRecordColumns,
      // A root Conversation has no agent tree.
      agentTreeRootLabel: sql<
        string | null
      >`case when ${juniorConversations.parentConversationId} is null then null else (${agentTreeRootLabel(db, rootConversationId)}) end`,
      attachmentsVersion: sql<string>`(${slackAttachmentsVersionQuery(db, conversationId)})`,
      autoArchive: juniorConversationParticipants.autoArchive,
      autoArchiveDefault: detailViewer.autoArchiveDefault,
      forkIds: sql<string[]>`array${forkIds}`,
      forkSourceId: forkSource.conversationId,
      forkSourceTitle: forkSource.title,
      lastReadSeq: viewer
        ? sql<
            number | null
          >`(${conversationReadPositionQuery(viewer, conversationId)})`
        : sql<null>`null`,
      pinnedAt: juniorConversationParticipants.pinnedAt,
      pinPosition: juniorConversationParticipants.pinPosition,
      rootConversationId,
      unreadReply: viewer
        ? unreadReplySql(
            db,
            viewer.id,
            rootConversationId,
            sql`(${db
              .select({ seq: juniorConversationReadPositions.lastReadSeq })
              .from(juniorConversationReadPositions)
              .where(
                and(
                  eq(juniorConversationReadPositions.userId, viewer.id),
                  eq(
                    juniorConversationReadPositions.conversationId,
                    rootConversationId,
                  ),
                ),
              )})`,
          )
        : sql<boolean>`false`,
      unsubscribedAt: juniorConversationParticipants.unsubscribedAt,
      version: sql<
        string | null
      >`(${conversationVersionQuery(db, conversationId, viewer?.id)})`,
    })
    .from(juniorConversations)
    .leftJoin(juniorDestinations, conversationRecordJoins.location)
    .leftJoin(juniorIdentities, conversationRecordJoins.identity)
    .leftJoin(juniorUsers, conversationRecordJoins.user)
    .leftJoin(
      forkSource,
      eq(
        forkSource.conversationId,
        juniorConversations.forkedFromConversationId,
      ),
    )
    .leftJoin(juniorConversationParticipants, viewerParticipant)
    .leftJoin(
      detailViewer,
      viewer ? eq(detailViewer.id, viewer.id) : sql`false`,
    )
    .where(eq(juniorConversations.conversationId, conversationId));
  return row;
}

/**
 * Viewer state (access, marks, read position, auto-archive choice) and data
 * that other Conversations own (forks).
 */
export type ConversationDetailState = {
  access?: ConversationAccess;
  autoArchive?: boolean;
  forks: Awaited<ReturnType<typeof readConversationForks>>;
  readPosition?: ConversationReadPosition;
  /** The viewer has not unsubscribed from the root. */
  subscribed?: boolean;
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
): Promise<
  DetailStateRead & {
    /** `agentTreeRootLabel` of a child, or undefined for a root. */
    agentTreeRootLabel: string | undefined;
    /** `conversationVersionQuery` token, or undefined when missing. */
    version: string | undefined;
  }
> {
  const rowRead = readDetailStateRow(conversationId, viewer);
  const [accessById, row, forks] = await Promise.all([
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
          isChild: Boolean(stored?.conversation.parentConversationId),
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
    agentTreeRootLabel: row?.agentTreeRootLabel ?? undefined,
    record: row ? conversationRecordFromRow(row) : undefined,
    state: {
      access,
      // The viewer's choice for the root, else their default.
      ...(viewer
        ? { autoArchive: row?.autoArchive ?? row?.autoArchiveDefault ?? false }
        : undefined),
      forks,
      ...(row?.lastReadSeq != null
        ? { readPosition: { lastReadSeq: row.lastReadSeq } }
        : undefined),
      ...(viewer ? { subscribed: !row?.unsubscribedAt } : undefined),
      transcriptVersion,
      ...(viewer && row ? { unreadReply: row.unreadReply } : undefined),
      ...(viewerMarks ? { viewerMarks } : undefined),
    },
    version: row?.version ?? undefined,
  };
}

/** The detail state and the record from the same read. */
export type DetailStateRead = {
  /** Undefined for a missing Conversation. */
  record: ConversationRecord | undefined;
  state: ConversationDetailState;
};

/**
 * Read the detail state that the ETag hashes and the report shows, with the
 * Conversation record.
 */
export async function readConversationDetailState(
  conversationId: string,
  viewer: User | undefined,
  readAccess: ConversationAccessReader,
): Promise<DetailStateRead> {
  const { record, state } = await readDetailState(
    conversationId,
    viewer,
    readAccess,
  );
  return { record, state };
}

/**
 * Return the detail ETag without building the report, or undefined for a
 * missing Conversation. The state and record come back too, so the report
 * reuses them and matches the ETag.
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
  | (DetailStateRead & {
      etag: string;
      /** `conversationVersionQuery` token of the same read. */
      version: string;
    })
  | undefined
> {
  const { agentTreeRootLabel, record, state, version } = await readDetailState(
    conversationId,
    options.viewer,
    options.readAccess,
  );
  if (!version) return undefined;
  const basis = JSON.stringify({
    // The report reads the agent tree itself. Its access is in `access`.
    access: state.access ?? null,
    agentTree: agentTreeRootLabel ?? null,
    autoArchive: state.autoArchive ?? null,
    forks: state.forks,
    junior: JUNIOR_VERSION,
    limit: options.limit ?? null,
    subscribed: state.subscribed ?? null,
    version,
    // The read position is not hashed, but whether it leaves a reply unread
    // is, so the next poll after a read or a mark shows the new state.
    unreadReply: state.unreadReply ?? false,
    viewerMarks: state.viewerMarks ?? null,
  });
  return {
    etag: createHash("sha256").update(basis).digest("hex"),
    record,
    state,
    version,
  };
}
