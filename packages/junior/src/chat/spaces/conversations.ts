/**
 * Conversations in a Space (`design/spaces.md`). Only the Lead stores its
 * Space. The Space's other Conversations are its children, and their child
 * agents are in the Space of their root, so none can disagree with it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { topLevelConversation } from "@/chat/conversations/sql/listed";
import { rootSpaceIdSql } from "@/chat/spaces/tree-space";
import { setMovedWorkVisibility } from "@/chat/conversations/sql/privacy";
import { alias } from "drizzle-orm/pg-core";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import { getSqlExecutor } from "@/chat/db";
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
        ? // A Space is its Lead, so the Lead's visibility is the Space's.
          await db
            .select({
              id: spaceLead.spaceId,
              visibility: spaceLead.visibility,
            })
            .from(spaceLead)
            .where(
              and(
                eq(spaceLead.kind, "lead"),
                inArray(spaceLead.spaceId, spaceIds),
              ),
            )
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
