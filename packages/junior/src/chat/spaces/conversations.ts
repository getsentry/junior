/**
 * Conversations in a Space (`design/spaces.md`). Only a root stores its
 * Space. A child is in the Space of its root, so the two never disagree.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { stopConversation } from "@/chat/conversations/stop";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getDb, getSqlExecutor } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations, juniorSpaces } from "@/db/schema";

/** The id and name that label a Conversation's Space. */
export interface SpaceRef {
  id: string;
  name: string;
}

const spaceRoot = alias(juniorConversations, "space_root");

/** Read the id and name of each Space, by id. A missing id has no entry. */
export async function readSpaceRefs(
  db: JuniorDatabase,
  spaceIds: Iterable<string>,
): Promise<Map<string, SpaceRef>> {
  const ids = [...new Set(spaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: juniorSpaces.id, name: juniorSpaces.name })
    .from(juniorSpaces)
    .where(inArray(juniorSpaces.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Put one root in a Space, or take it out of every Space with null. Returns
 * false when no root has the id. The caller checks who may move it.
 */
export async function setConversationSpace(
  conversationId: string,
  spaceId: string | null,
): Promise<boolean> {
  const rows = await getDb()
    .update(juniorConversations)
    .set({ spaceId, detailVersion: nextDetailVersion })
    .where(
      and(
        eq(juniorConversations.conversationId, conversationId),
        isNull(juniorConversations.parentConversationId),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  return rows.length > 0;
}

/** Every Conversation in the Space, at any depth. */
function inSpaceTrees(db: JuniorDatabase, spaceId: string) {
  return inArray(
    juniorConversations.rootConversationId,
    db
      .select({ id: spaceRoot.conversationId })
      .from(spaceRoot)
      .where(eq(spaceRoot.spaceId, spaceId)),
  );
}

/**
 * Archive or restore a Space with its Conversations.
 *
 * Archive writes one time to the Space and to each unarchived Conversation
 * in it, at any depth. Then it stops each root that is not stopped, with the
 * child agents below it, so no work in the Space keeps running. A retry
 * stops what an earlier try left running.
 *
 * Restore clears the Space and the Conversations that its archive wrote. A
 * Conversation that was archived on its own stays archived. Restore starts
 * no work.
 */
export async function setSpaceArchive(args: {
  archived: boolean;
  queue: ConversationWorkQueue;
  spaceId: string;
}): Promise<void> {
  const executor = getSqlExecutor();
  await executor.transaction(async () => {
    const db = executor.db();
    const [space] = await db
      .select({ archivedAt: juniorSpaces.archivedAt })
      .from(juniorSpaces)
      .where(eq(juniorSpaces.id, args.spaceId))
      .limit(1)
      .for("update");
    if (!space) return;
    const now = new Date();
    if (args.archived) {
      if (space.archivedAt) return;
      await db
        .update(juniorSpaces)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(juniorSpaces.id, args.spaceId));
      await setArchivedAt(
        db,
        inSpaceTrees(db, args.spaceId),
        now,
        isNull(juniorConversations.archivedAt),
      );
      return;
    }
    if (!space.archivedAt) return;
    await db
      .update(juniorSpaces)
      .set({ archivedAt: null, updatedAt: now })
      .where(eq(juniorSpaces.id, args.spaceId));
    await setArchivedAt(
      db,
      inSpaceTrees(db, args.spaceId),
      null,
      eq(juniorConversations.archivedAt, space.archivedAt),
    );
  });
  if (!args.archived) return;
  const running = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.spaceId, args.spaceId),
        isNull(juniorConversations.stoppedAt),
      ),
    );
  await mapBounded(running, ({ conversationId }) =>
    stopConversation({ conversationId, queue: args.queue }),
  );
}
