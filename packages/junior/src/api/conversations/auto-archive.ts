/**
 * Auto-archive archives a user's conversation when its work is done.
 *
 * A user turns it on with `autoArchiveDefault` and can override it for one
 * conversation on their participant row. The user also picks the grace
 * period in `autoArchiveGraceHours`. The scheduled sweep archives only for
 * users whose effective choice is on. A conversation is done when:
 *
 * - no plugin reported unfinished work on it or a child conversation
 * - any reported work finished at least the grace period ago, and no human
 *   message arrived after it finished
 * - the root and every child conversation are idle
 * - no open Review item on it waits on the user
 * - the user did not pin it
 * - the root and every child conversation had no activity during the grace
 *   period
 *
 * A user can also archive all of their done conversations once, from
 * Settings. That run has no grace period, does not need auto-archive on, and
 * skips conversations where the user turned auto-archive off.
 *
 * Archive stays per user. A new human message restores it, and a manual
 * restore turns auto-archive off for that conversation.
 */
import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, getSqlExecutor } from "@/chat/db";
import { logInfo } from "@/chat/logging";
import { listConversationWork } from "@/chat/plugins/unfinished-work";
import { resolveRootConversationId } from "@/chat/conversations/sql/participants";
import { reviewItemNeedsUser } from "@/chat/review-items/access";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorReviewItemConversations,
  juniorReviewItems,
  juniorUsers,
} from "@/db/schema";
import { AUTO_ARCHIVE_DEFAULT_GRACE_HOURS } from "@/db/schema/users";
import { throwApiError } from "../http";
import { readConversationAccessFromSql } from "./access";
import { readLastUserMessageAtByConversation } from "./user-message-activity";

const HOUR_MS = 60 * 60 * 1000;

/** Participant rows checked per page. A run reads pages until none remain. */
const AUTO_ARCHIVE_PAGE_SIZE = 500;

export type ConversationDoneInput = {
  assignedWork?: boolean;
  finishedWorkAt?: string;
  lastUserMessageAt?: string;
  unfinishedWork?: boolean;
};

/** A user's auto-archive settings. */
export type AutoArchiveSettings = {
  autoArchiveDefault: boolean;
  autoArchiveGraceHours: number;
};

/** Settings of a user who has not changed auto-archive. */
export const DEFAULT_AUTO_ARCHIVE_SETTINGS: AutoArchiveSettings = {
  autoArchiveDefault: false,
  autoArchiveGraceHours: AUTO_ARCHIVE_DEFAULT_GRACE_HOURS,
};

/**
 * Decide whether a conversation's work is done long enough to auto-archive.
 * A conversation without plugin-reported work has nothing to wait for, so
 * the quiet-tree checks alone decide it.
 */
export function isConversationWorkDone(
  conversation: ConversationDoneInput,
  cutoffMs: number,
): boolean {
  if (conversation.unfinishedWork) return false;
  if (!conversation.assignedWork) return true;
  const finishedAt = Date.parse(conversation.finishedWorkAt ?? "");
  if (!Number.isFinite(finishedAt) || finishedAt > cutoffMs) return false;
  const lastUserMessageAt = Date.parse(conversation.lastUserMessageAt ?? "");
  return !(
    Number.isFinite(lastUserMessageAt) && lastUserMessageAt > finishedAt
  );
}

/**
 * One archive run for one user. A scheduled run needs the user's effective
 * auto-archive choice and waits the grace period. A manual run skips only
 * conversations where the user turned auto-archive off.
 */
type ArchiveRun = {
  graceHours: number;
  kind: "manual" | "scheduled";
  now: Date;
  userId: string;
};

function runOptsIn(run: ArchiveRun): SQL {
  return run.kind === "scheduled"
    ? sql`coalesce(${juniorConversationParticipants.autoArchive}, ${juniorUsers.autoArchiveDefault}) = true`
    : sql`${juniorConversationParticipants.autoArchive} is distinct from false`;
}

function runCutoff(run: ArchiveRun): Date {
  return new Date(run.now.getTime() - run.graceHours * HOUR_MS);
}

/**
 * True when the participant row's root and every child conversation are idle
 * and had no activity after the cutoff. Child activity does not move the
 * root's `lastActivityAt`, so the whole tree is checked.
 */
function treeIsQuiet(cutoff: Date) {
  const active = getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        or(
          eq(
            juniorConversations.conversationId,
            juniorConversationParticipants.rootConversationId,
          ),
          eq(
            juniorConversations.rootConversationId,
            juniorConversationParticipants.rootConversationId,
          ),
        ),
        or(
          ne(juniorConversations.executionStatus, "idle"),
          gt(juniorConversations.lastActivityAt, cutoff),
        ),
      ),
    );
  return sql`not exists (${active})`;
}

/**
 * True when no open Review item on the participant row's root or a child
 * conversation needs the user. Such a conversation waits on them, so it must
 * stay in their feed.
 */
function notWaitingOnUser(userId: string) {
  const linked = alias(juniorConversations, "linked_conversation");
  const waiting = getDb()
    .select({ itemId: juniorReviewItemConversations.itemId })
    .from(juniorReviewItemConversations)
    .innerJoin(
      juniorReviewItems,
      eq(juniorReviewItems.id, juniorReviewItemConversations.itemId),
    )
    .innerJoin(
      linked,
      eq(linked.conversationId, juniorReviewItemConversations.conversationId),
    )
    .where(
      and(
        reviewItemNeedsUser(userId),
        or(
          eq(
            linked.conversationId,
            juniorConversationParticipants.rootConversationId,
          ),
          eq(
            linked.rootConversationId,
            juniorConversationParticipants.rootConversationId,
          ),
        ),
      ),
    );
  return sql`not exists (${waiting})`;
}

/**
 * Conditions that a participant row must meet when it is selected and again
 * when it is archived, so new activity, a new run, a new Review item, or a
 * changed setting wins over a stale read.
 */
function archivableRow(run: ArchiveRun) {
  return and(
    eq(juniorConversationParticipants.userId, run.userId),
    isNull(juniorConversationParticipants.archivedAt),
    // A pin keeps the conversation in the feed on purpose.
    isNull(juniorConversationParticipants.pinnedAt),
    // The user's own message or a root activity snapshot sets
    // `lastMessageAt`. A later value means the tree had activity after the
    // cutoff, so this cheap indexed check removes most rows first.
    lte(juniorConversationParticipants.lastMessageAt, runCutoff(run)),
    runOptsIn(run),
    run.kind === "scheduled"
      ? sql`${juniorUsers.autoArchiveGraceHours} <= ${run.graceHours}`
      : undefined,
    treeIsQuiet(runCutoff(run)),
    notWaitingOnUser(run.userId),
  );
}

/** Keyset position in the user's unarchived rows, ordered by last message. */
type CandidateCursor = { lastMessageAt: string; rootConversationId: string };

/**
 * One page of the user's unarchived participant rows that may be done. Pages
 * follow `junior_conversation_participants_unarchived_activity_idx`, so a run
 * reads only rows older than the cutoff. Archive writes during the run do not
 * move `lastMessageAt`, so they do not skip rows.
 */
async function selectCandidateRoots(run: ArchiveRun, after?: CandidateCursor) {
  return await getDb()
    .select({
      // Text keeps the full timestamp precision for the next page.
      lastMessageAt: sql<string>`${juniorConversationParticipants.lastMessageAt}::text`,
      rootConversationId: juniorConversationParticipants.rootConversationId,
    })
    .from(juniorConversationParticipants)
    .innerJoin(
      juniorUsers,
      eq(juniorUsers.id, juniorConversationParticipants.userId),
    )
    .where(
      and(
        archivableRow(run),
        after
          ? sql`(${juniorConversationParticipants.lastMessageAt}, ${juniorConversationParticipants.rootConversationId}) > (${after.lastMessageAt}::timestamptz, ${after.rootConversationId})`
          : undefined,
      ),
    )
    .orderBy(
      asc(juniorConversationParticipants.lastMessageAt),
      asc(juniorConversationParticipants.rootConversationId),
    )
    .limit(AUTO_ARCHIVE_PAGE_SIZE);
}

/**
 * Keep the roots whose work is done. Work comes first, so the message
 * history read covers only roots with finished work.
 */
async function selectDoneRoots(
  rootIds: string[],
  cutoffMs: number,
): Promise<string[]> {
  const work = await listConversationWork(rootIds);
  const assigned = new Set(work.assignedIds);
  const unfinished = new Set(work.unfinishedIds);
  const finished = work.assignedIds.filter(
    (id) =>
      !unfinished.has(id) &&
      isConversationWorkDone(
        { assignedWork: true, finishedWorkAt: work.finishedAtById[id] },
        cutoffMs,
      ),
  );
  const lastUserMessageAtById = await readLastUserMessageAtByConversation(
    getDb(),
    finished,
  );
  return rootIds.filter((id) =>
    isConversationWorkDone(
      {
        assignedWork: assigned.has(id),
        finishedWorkAt: work.finishedAtById[id],
        lastUserMessageAt: lastUserMessageAtById.get(id),
        unfinishedWork: unfinished.has(id),
      },
      cutoffMs,
    ),
  );
}

/** Archive one root for the run's user when it is still archivable. */
async function archiveRoot(
  run: ArchiveRun,
  rootConversationId: string,
): Promise<boolean> {
  // oxlint-disable-next-line junior/touch-conversation-detail -- viewer marks are read on each request.
  const updated = await getDb()
    .update(juniorConversationParticipants)
    .set({ archivedAt: run.now })
    .from(juniorUsers)
    .where(
      and(
        eq(juniorUsers.id, juniorConversationParticipants.userId),
        eq(
          juniorConversationParticipants.rootConversationId,
          rootConversationId,
        ),
        archivableRow(run),
      ),
    )
    .returning({ userId: juniorConversationParticipants.userId });
  return updated.length > 0;
}

/** Archive every done conversation of one user and count the rows. */
async function archiveUserDoneConversations(
  run: ArchiveRun,
): Promise<{ archived: number; scanned: number }> {
  const cutoffMs = runCutoff(run).getTime();
  let after: CandidateCursor | undefined;
  let archived = 0;
  let scanned = 0;
  for (;;) {
    const rows = await selectCandidateRoots(run, after);
    if (rows.length === 0) break;
    scanned += rows.length;
    const rootIds = rows.map((row) => row.rootConversationId);
    for (const rootId of await selectDoneRoots(rootIds, cutoffMs)) {
      if (await archiveRoot(run, rootId)) archived += 1;
    }
    if (rows.length < AUTO_ARCHIVE_PAGE_SIZE) break;
    after = rows.at(-1);
  }
  return { archived, scanned };
}

/**
 * Users with auto-archive on by default or for at least one unarchived
 * conversation. Most users never turn it on, so the sweep reads only these.
 */
async function selectAutoArchiveUsers() {
  const optedInConversation = getDb()
    .select({ userId: juniorConversationParticipants.userId })
    .from(juniorConversationParticipants)
    .where(
      and(
        eq(juniorConversationParticipants.userId, juniorUsers.id),
        eq(juniorConversationParticipants.autoArchive, true),
        isNull(juniorConversationParticipants.archivedAt),
      ),
    );
  return await getDb()
    .select({
      graceHours: juniorUsers.autoArchiveGraceHours,
      id: juniorUsers.id,
    })
    .from(juniorUsers)
    .where(
      or(
        eq(juniorUsers.autoArchiveDefault, true),
        sql`exists (${optedInConversation})`,
      ),
    )
    .orderBy(asc(juniorUsers.id));
}

/**
 * Run one auto-archive sweep over every user who wants it and return how
 * many participant rows it checked and archived.
 */
export async function runAutoArchiveSweep(args: {
  nowMs: number;
}): Promise<{ archived: number; scanned: number }> {
  const now = new Date(args.nowMs);
  let archived = 0;
  let scanned = 0;
  for (const user of await selectAutoArchiveUsers()) {
    const result = await archiveUserDoneConversations({
      graceHours: user.graceHours,
      kind: "scheduled",
      now,
      userId: user.id,
    });
    archived += result.archived;
    scanned += result.scanned;
  }
  logInfo("auto_archive.sweep.completed", {
    "app.auto_archive.archived": archived,
    "app.auto_archive.scanned": scanned,
  });
  return { archived, scanned };
}

/**
 * Archive all of the viewer's done conversations now, with no grace period.
 * It skips conversations where the viewer turned auto-archive off.
 */
export async function archiveViewerDoneConversations(
  viewer: User,
): Promise<{ archived: number }> {
  const { archived } = await archiveUserDoneConversations({
    graceHours: 0,
    kind: "manual",
    now: new Date(),
    userId: viewer.id,
  });
  return { archived };
}

/** Read the viewer's effective auto-archive choice for a conversation root. */
export async function readConversationAutoArchive(
  viewer: User,
  rootConversationId: string,
): Promise<boolean> {
  const [user] = await getDb()
    .select({
      autoArchive: juniorConversationParticipants.autoArchive,
      autoArchiveDefault: juniorUsers.autoArchiveDefault,
    })
    .from(juniorUsers)
    .leftJoin(
      juniorConversationParticipants,
      and(
        eq(juniorConversationParticipants.userId, juniorUsers.id),
        eq(
          juniorConversationParticipants.rootConversationId,
          rootConversationId,
        ),
      ),
    )
    .where(eq(juniorUsers.id, viewer.id))
    .limit(1);
  return user?.autoArchive ?? user?.autoArchiveDefault ?? false;
}

/** Turn auto-archive on or off for one conversation and the signed-in viewer. */
export async function setConversationAutoArchive(
  viewer: User,
  conversationId: string,
  autoArchive: boolean,
): Promise<{ autoArchive: boolean }> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const rootConversationId = await resolveRootConversationId(
    getSqlExecutor(),
    conversationId,
  );
  const [root] = await getDb()
    .select({ lastActivityAt: juniorConversations.lastActivityAt })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, rootConversationId))
    .limit(1);
  if (!root) throwApiError(404, "Conversation not found.");
  // The root actor may not have a participant row yet. The detail ETag reads
  // the auto-archive choice on each request.
  // oxlint-disable-next-line junior/touch-conversation-detail -- see above.
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      autoArchive,
      lastMessageAt: root.lastActivityAt,
      rootConversationId,
      userId: viewer.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorConversationParticipants.userId,
        juniorConversationParticipants.rootConversationId,
      ],
      set: { autoArchive },
    });
  return { autoArchive };
}

/** Read the user's auto-archive settings. */
export async function readUserAutoArchiveSettings(
  userId: string,
): Promise<AutoArchiveSettings | undefined> {
  const [user] = await getDb()
    .select({
      autoArchiveDefault: juniorUsers.autoArchiveDefault,
      autoArchiveGraceHours: juniorUsers.autoArchiveGraceHours,
    })
    .from(juniorUsers)
    .where(eq(juniorUsers.id, userId))
    .limit(1);
  return user;
}

/** Save changed auto-archive settings and return the saved settings. */
export async function updateUserAutoArchiveSettings(
  userId: string,
  settings: Partial<AutoArchiveSettings>,
): Promise<AutoArchiveSettings | undefined> {
  const [user] = await getDb()
    .update(juniorUsers)
    .set({ ...settings, updatedAt: new Date() })
    .where(eq(juniorUsers.id, userId))
    .returning({
      autoArchiveDefault: juniorUsers.autoArchiveDefault,
      autoArchiveGraceHours: juniorUsers.autoArchiveGraceHours,
    });
  return user;
}
