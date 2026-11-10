import {
  and,
  arrayOverlaps,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import { conversationAnnotationInputSchema } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { listedConversation } from "@/chat/conversations/sql/listed";
import type {
  ConversationKind,
  ConversationStatus,
} from "@/chat/conversations/store";
import {
  PLUGIN_REVIEW_ITEM_KEY_PREFIX,
  reviewItemNeedsUser,
} from "@/chat/review-items/access";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversationAnnotations,
  juniorConversations,
  juniorReviewItemConversations,
  juniorReviewItems,
} from "@/db/schema";
import { conversationIsMemberRoot } from "../conversations/membership";
import { readConversationParticipants } from "../conversations/participants";
import type { BoardCard, BoardReport } from "../schema/board";
import {
  BOARD_DONE_WINDOW_HOURS,
  codeChangeColumn,
  ticketColumn,
} from "./columns";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Root Conversations with activity in this window feed the Board. */
const ACTIVE_WINDOW_MS = 14 * DAY_MS;
/** Bound the Board to the viewer's most recent root Conversations. */
const ROOT_LIMIT = 200;

type TreeNode = {
  archived: boolean;
  conversationId: string;
  createdAtMs: number;
  kind: ConversationKind | null;
  parentConversationId: string | null;
  status: ConversationStatus;
  title: string | null;
};

type CardHome = Pick<BoardCard, "conversation" | "participants"> & {
  needsViewer: boolean;
  working: boolean;
};

function parentOf(
  nodes: ReadonlyMap<string, TreeNode>,
  node: TreeNode,
): TreeNode | undefined {
  return node.parentConversationId
    ? nodes.get(node.parentConversationId)
    : undefined;
}

/**
 * A card belongs to the nearest root or Thread. People do not message a
 * Task, so its work shows on its parent. A row from an older deploy has no
 * kind; a child without a kind is treated as a Task. A Conversation shows
 * only while it and every ancestor are unarchived.
 */
function homeId(
  nodes: ReadonlyMap<string, TreeNode>,
  conversationId: string,
): string | undefined {
  const start = nodes.get(conversationId);
  for (let node = start; node; node = parentOf(nodes, node)) {
    if (node.archived) return undefined;
  }
  let node = start;
  while (
    node &&
    (node.kind === "task" || (!node.kind && node.parentConversationId))
  ) {
    node = parentOf(nodes, node);
  }
  return node?.conversationId;
}

function rootOf(
  nodes: ReadonlyMap<string, TreeNode>,
  node: TreeNode,
): TreeNode {
  let current = node;
  for (
    let parent = parentOf(nodes, current);
    parent;
    parent = parentOf(nodes, parent)
  ) {
    current = parent;
  }
  return current;
}

async function readViewerTrees(userId: string, nowMs: number) {
  const db = getDb();
  const roots = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        conversationIsMemberRoot({ userId }),
        listedConversation(),
        isNull(juniorConversations.archivedAt),
        gte(
          juniorConversations.lastActivityAt,
          new Date(nowMs - ACTIVE_WINDOW_MS),
        ),
      ),
    )
    .orderBy(desc(juniorConversations.lastActivityAt))
    .limit(ROOT_LIMIT);
  const rootIds = roots.map((row) => row.conversationId);
  if (rootIds.length === 0)
    return { nodes: new Map<string, TreeNode>(), rootIds };
  const rows = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      kind: juniorConversations.kind,
      parentConversationId: juniorConversations.parentConversationId,
      status: juniorConversations.executionStatus,
      title: juniorConversations.title,
    })
    .from(juniorConversations)
    .where(
      or(
        inArray(juniorConversations.conversationId, rootIds),
        inArray(juniorConversations.rootConversationId, rootIds),
      ),
    );
  const nodes = new Map<string, TreeNode>(
    rows.map((row) => [
      row.conversationId,
      {
        archived: row.archivedAt !== null,
        conversationId: row.conversationId,
        createdAtMs: row.createdAt.getTime(),
        kind: row.kind,
        parentConversationId: row.parentConversationId,
        status: row.status,
        title: row.title,
      },
    ]),
  );
  return { nodes, rootIds };
}

/**
 * Read the viewer's Board: the code changes and tickets of their recent
 * Conversations, each in one column. See `./columns` for the column rules.
 */
export async function readBoard(args: {
  nowMs: number;
  userId: string;
}): Promise<BoardReport> {
  const db = getDb();
  const { nodes, rootIds } = await readViewerTrees(args.userId, args.nowMs);
  const treeIds = [...nodes.keys()];
  if (treeIds.length === 0) {
    return { cards: [], doneWindowHours: BOARD_DONE_WINDOW_HOURS };
  }

  const doneSince = new Date(
    args.nowMs - BOARD_DONE_WINDOW_HOURS * 60 * 60 * 1_000,
  );
  const [codeChanges, ticketRows, needsViewerRows, participants] =
    await Promise.all([
      db
        .select({
          conversationIds: juniorCodeChanges.conversationIds,
          id: juniorCodeChanges.id,
          mergedAt: juniorCodeChanges.mergedAt,
          number: juniorCodeChanges.number,
          repository: juniorCodeRepositories.name,
          state: juniorCodeChanges.state,
          title: juniorCodeChanges.title,
          updatedAt: juniorCodeChanges.updatedAt,
          url: juniorCodeChanges.url,
        })
        .from(juniorCodeChanges)
        .innerJoin(
          juniorCodeRepositories,
          eq(juniorCodeRepositories.id, juniorCodeChanges.repositoryId),
        )
        .where(
          and(
            or(
              eq(juniorCodeChanges.state, "open"),
              and(
                eq(juniorCodeChanges.state, "merged"),
                gte(juniorCodeChanges.mergedAt, doneSince),
              ),
            ),
            arrayOverlaps(juniorCodeChanges.conversationIds, treeIds),
          ),
        ),
      db
        .select({
          annotation: juniorConversationAnnotations.annotation,
          conversationId: juniorConversationAnnotations.conversationId,
          key: juniorConversationAnnotations.key,
          plugin: juniorConversationAnnotations.plugin,
          updatedAt: juniorConversationAnnotations.updatedAt,
        })
        .from(juniorConversationAnnotations)
        .where(
          and(
            inArray(juniorConversationAnnotations.conversationId, treeIds),
            sql`${juniorConversationAnnotations.annotation}->>'objectType' = 'task'`,
          ),
        ),
      db
        .selectDistinct({
          conversationId: juniorReviewItemConversations.conversationId,
        })
        .from(juniorReviewItemConversations)
        .innerJoin(
          juniorReviewItems,
          eq(juniorReviewItems.id, juniorReviewItemConversations.itemId),
        )
        .where(
          and(
            inArray(juniorReviewItemConversations.conversationId, treeIds),
            reviewItemNeedsUser(args.userId),
          ),
        ),
      readConversationParticipants(db, rootIds),
    ]);

  const codeChangeUrls = codeChanges.flatMap((change) =>
    change.state === "open" && change.url ? [change.url] : [],
  );
  const readyUrls = new Set(
    codeChangeUrls.length === 0
      ? []
      : (
          await db
            .select({ subjectId: juniorReviewItems.subjectId })
            .from(juniorReviewItems)
            .where(
              and(
                eq(juniorReviewItems.status, "open"),
                eq(juniorReviewItems.kind, "notice"),
                like(
                  juniorReviewItems.dedupeKey,
                  `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}%`,
                ),
                inArray(juniorReviewItems.subjectId, codeChangeUrls),
              ),
            )
        ).flatMap((row) => (row.subjectId ? [row.subjectId] : [])),
  );

  // Labels and people come from the home Conversation of each card.
  const homes = new Map<string, CardHome>();
  const workingHomes = new Set<string>();
  const needsViewerHomes = new Set<string>();
  for (const node of nodes.values()) {
    if (node.status !== "running" && node.status !== "pending") continue;
    const home = homeId(nodes, node.conversationId);
    if (home) workingHomes.add(home);
  }
  for (const row of needsViewerRows) {
    const home = homeId(nodes, row.conversationId);
    if (home) needsViewerHomes.add(home);
  }
  // An object can link to several Conversations. Its home is the oldest
  // visible home among them, so the card stays in one place when links
  // change order or a linked Conversation is archived. Homes are ranked,
  // not linked Conversations, because a Task is newer than its Thread.
  const homeFor = (conversationIds: Iterable<string>): CardHome | undefined => {
    let node: TreeNode | undefined;
    for (const conversationId of conversationIds) {
      const candidateId = homeId(nodes, conversationId);
      const candidate = candidateId ? nodes.get(candidateId) : undefined;
      if (!candidate) continue;
      if (
        !node ||
        candidate.createdAtMs < node.createdAtMs ||
        (candidate.createdAtMs === node.createdAtMs &&
          candidate.conversationId < node.conversationId)
      ) {
        node = candidate;
      }
    }
    if (!node) return undefined;
    const id = node.conversationId;
    const cached = homes.get(id);
    if (cached) return cached;
    const root = rootOf(nodes, node);
    const home: CardHome = {
      conversation: {
        conversationId: id,
        ...(node.title ? { title: node.title } : undefined),
        ...(root !== node && root.title
          ? { rootTitle: root.title }
          : undefined),
      },
      needsViewer: needsViewerHomes.has(id),
      participants: participants.get(root.conversationId) ?? [],
      working: workingHomes.has(id),
    };
    homes.set(id, home);
    return home;
  };

  const cards: BoardCard[] = [];
  for (const change of codeChanges) {
    const home = homeFor(change.conversationIds);
    if (!home) continue;
    const mergedAtMs = change.mergedAt?.getTime();
    const column = codeChangeColumn({
      hasReadyNotice: Boolean(change.url && readyUrls.has(change.url)),
      ...(mergedAtMs !== undefined ? { mergedAtMs } : undefined),
      nowMs: args.nowMs,
      state: change.state,
    });
    if (!column) continue;
    const label = `${change.repository}#${change.number}`;
    cards.push({
      column,
      conversation: home.conversation,
      key: `code_change:${change.id}`,
      label,
      needsViewer: home.needsViewer,
      objectType: "code_change",
      participants: home.participants,
      status: change.state,
      title: change.title ?? label,
      updatedAt: (change.mergedAt ?? change.updatedAt).toISOString(),
      ...(change.url ? { url: change.url } : undefined),
      working: home.working,
    });
  }

  // One ticket can be saved in several Conversations of a tree. The newest
  // annotation has its current state.
  const tickets = new Map<
    string,
    { conversationIds: Set<string>; latest: (typeof ticketRows)[number] }
  >();
  for (const row of ticketRows) {
    const key = `${row.plugin}:${row.key}`;
    const current = tickets.get(key);
    if (!current) {
      tickets.set(key, {
        conversationIds: new Set([row.conversationId]),
        latest: row,
      });
      continue;
    }
    current.conversationIds.add(row.conversationId);
    if (row.updatedAt > current.latest.updatedAt) current.latest = row;
  }
  for (const [key, ticket] of tickets) {
    const parsed = conversationAnnotationInputSchema.safeParse(
      ticket.latest.annotation,
    );
    if (!parsed.success) continue;
    const annotation = parsed.data;
    const status = annotation.status;
    if (!status) continue;
    const home = homeFor(ticket.conversationIds);
    if (!home) continue;
    const column = ticketColumn({
      nowMs: args.nowMs,
      status,
      updatedAtMs: ticket.latest.updatedAt.getTime(),
      working: home.working,
    });
    if (!column) continue;
    const title =
      annotation.kind === "object"
        ? annotation.title
        : (annotation.description ?? annotation.label);
    cards.push({
      column,
      conversation: home.conversation,
      key: `ticket:${key}`,
      label: annotation.label,
      needsViewer: home.needsViewer,
      objectType: "task",
      participants: home.participants,
      status,
      title,
      updatedAt: ticket.latest.updatedAt.toISOString(),
      ...(annotation.url ? { url: annotation.url } : undefined),
      working: home.working,
    });
  }

  cards.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { cards, doneWindowHours: BOARD_DONE_WINDOW_HOURS };
}
