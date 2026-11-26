/**
 * Conversations in a Space (`design/spaces.md`). Only the Lead stores its
 * Space. The Space's other Conversations are its children, and their child
 * agents are in the Space of their root, so none can disagree with it.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { topLevelConversation } from "@/chat/conversations/sql/listed";
import { rootSpaceIdSql } from "@/chat/spaces/tree-space";
import { setMovedWorkVisibility } from "@/chat/conversations/sql/privacy";
import { alias } from "drizzle-orm/pg-core";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { stopConversation } from "@/chat/conversations/stop";
import { setArchivedAt } from "@/chat/conversations/sql/conversation-tree";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getDb, getSqlExecutor } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorSpaces,
} from "@/db/schema";

/** The id and name that label a Conversation's Space. */
export interface SpaceRef {
  id: string;
  name: string;
}

const spaceRoot = alias(juniorConversations, "space_root");
const spaceLead = alias(juniorConversations, "space_lead");

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

/** Why `setConversationSpace` did not move a Conversation. */
export type SpaceMoveRefusal =
  /** No tree root has the id. */
  | "not_found"
  /** Another move changed its Space after the caller checked it. */
  | "moved"
  /** It is in a private Space, and its data stays with the members. */
  | "leaves_private"
  /** It is private, and a public Space would make its data public. */
  | "private_into_public"
  /**
   * The Space is private, and the Conversation shares its Location, such as
   * a Slack channel, with people who are not members.
   */
  | "shared_location";

/** The Space that a move puts a Conversation in, with the Space's Lead. */
export interface SpaceMoveTarget {
  leadConversationId: string;
  spaceId: string;
}

/**
 * Put one top-level Conversation in a Space, or take it out of every Space
 * with null. In a Space it is a child of the Space's Lead, and its work is
 * in the Lead's tree. Out of one it is a root again. Its child agents move
 * with it. It gets a private Space's visibility, on its work and on its own
 * Location. The caller checks who may move it out of `fromSpaceId`, the
 * Space that it read before the move.
 */
export async function setConversationSpace(
  conversationId: string,
  target: SpaceMoveTarget | null,
  fromSpaceId: string | null,
): Promise<SpaceMoveRefusal | undefined> {
  const executor = getSqlExecutor();
  return await executor.transaction(async () => {
    const db = executor.db();
    // Lock the Conversation, so two moves of it run one after the other. A
    // Space keeps its visibility, so the Spaces need no lock.
    const [root] = await db
      .select({
        locationId: juniorConversations.destinationId,
        provider: juniorDestinations.provider,
        spaceId: rootSpaceIdSql(juniorConversations),
        visibility: juniorConversations.visibility,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(
        and(
          eq(juniorConversations.conversationId, conversationId),
          eq(juniorConversations.kind, "thread"),
          topLevelConversation(),
        ),
      )
      .limit(1)
      .for("update", { of: juniorConversations });
    if (!root) return "not_found";
    const currentSpaceId = root.spaceId;
    // The caller's membership check covers only the Space that it read.
    if (currentSpaceId !== fromSpaceId) return "moved";
    const spaceIds = [currentSpaceId, target?.spaceId].filter(
      (id): id is string => typeof id === "string",
    );
    const spaces =
      spaceIds.length > 0
        ? await db
            .select({
              id: juniorSpaces.id,
              visibility: juniorSpaces.visibility,
            })
            .from(juniorSpaces)
            .where(inArray(juniorSpaces.id, spaceIds))
        : [];
    const source = spaces.find((space) => space.id === currentSpaceId);
    if (source?.visibility === "private") return "leaves_private";
    const space = spaces.find((space) => space.id === target?.spaceId);
    if (space?.visibility === "public" && root.visibility !== "public") {
      return "private_into_public";
    }
    // The Conversation and its child agents, read before the move changes
    // their root. Each statement reads it once, when it starts.
    const work = inArray(
      juniorConversations.conversationId,
      sql`(select ${conversationSubtreeColumns.conversationId} from ${conversationSubtree([conversationId])})`,
    );
    if (space?.visibility === "private") {
      if (root.provider !== "local" || !root.locationId) {
        return "shared_location";
      }
      await db
        .update(juniorDestinations)
        .set({ visibility: "private", updatedAt: new Date() })
        .where(eq(juniorDestinations.id, root.locationId));
      await setMovedWorkVisibility(executor, conversationId, "private");
    }
    // Its work joins the tree of its new parent: the Lead's, or its own.
    await db
      .update(juniorConversations)
      .set({
        rootConversationId: target?.leadConversationId ?? conversationId,
        detailVersion: nextDetailVersion,
      })
      .where(work);
    await db
      .update(juniorConversations)
      .set({
        parentConversationId: target?.leadConversationId ?? null,
        // A Lead's children are its child agents.
        ...(target
          ? {
              agentConfig: sql`coalesce(${juniorConversations.agentConfig}, '{}'::jsonb)`,
            }
          : undefined),
        detailVersion: nextDetailVersion,
      })
      .where(eq(juniorConversations.conversationId, conversationId));
    return undefined;
  });
}

/** The ids of a Space's Lead and of its top-level Conversations. */
function spaceRootIds(db: JuniorDatabase, spaceId: string) {
  const leads = db
    .select({ id: spaceLead.conversationId })
    .from(spaceLead)
    .where(eq(spaceLead.spaceId, spaceId));
  return db
    .select({ id: spaceRoot.conversationId })
    .from(spaceRoot)
    .where(
      or(
        inArray(spaceRoot.conversationId, leads),
        inArray(spaceRoot.parentConversationId, leads),
      ),
    );
}

/** Every Conversation in the Space, at any depth: the Lead's tree. */
function inSpaceTrees(db: JuniorDatabase, spaceId: string) {
  const leads = db
    .select({ id: spaceLead.conversationId })
    .from(spaceLead)
    .where(eq(spaceLead.spaceId, spaceId));
  return or(
    inArray(juniorConversations.rootConversationId, leads),
    inArray(juniorConversations.conversationId, leads),
  )!;
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
  const db = getDb();
  const running = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        inArray(
          juniorConversations.conversationId,
          spaceRootIds(db, args.spaceId),
        ),
        isNull(juniorConversations.stoppedAt),
      ),
    );
  await mapBounded(running, ({ conversationId }) =>
    stopConversation({ conversationId, queue: args.queue }),
  );
}
