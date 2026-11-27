/**
 * Conversations in a Space (`design/spaces.md`). Only the Lead stores its
 * Space. The Space's other Conversations are its children, and their child
 * agents are in the Space of their root, so none can disagree with it.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ownLocalDestination } from "@/chat/conversations/destination";
import type { Location } from "@/chat/conversations/location";
import { nextDetailVersion } from "@/chat/conversations/sql/detail-version";
import {
  destinationUpsertFromDestination,
  upsertDestination,
} from "@/chat/conversations/sql/destination-upsert";
import { withConversationMutationLock } from "@/chat/conversations/sql/store";
import {
  conversationSubtree,
  conversationSubtreeColumns,
} from "@/chat/conversations/sql/subtree";
import { getSqlExecutor } from "@/chat/db";
import { isLeadSql, rootSpaceIdSql } from "@/chat/spaces/tree-space";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversations } from "@/db/schema";

/** The id and name that label a Conversation's Space. */
export interface SpaceRef {
  id: string;
  name: string;
}

/** Read the id and name of each Space, by id. A missing id has no entry. */
export async function readSpaceRefs(
  db: JuniorDatabase,
  spaceIds: Iterable<string>,
): Promise<Map<string, SpaceRef>> {
  const ids = [...new Set(spaceIds)];
  if (ids.length === 0) return new Map();
  // A Space's name is its Lead's title.
  const rows = await db
    .select({
      id: juniorConversations.spaceId,
      name: juniorConversations.title,
    })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.kind, "lead"),
        inArray(juniorConversations.spaceId, ids),
      ),
    );
  return new Map(
    rows.flatMap(({ id, name }) =>
      id ? [[id, { id, name: name ?? "" }]] : [],
    ),
  );
}

/** Why `setConversationSpace` did not move a Conversation. */
export type SpaceMoveRefusal =
  /** No movable Conversation has the id. */
  | "not_found"
  /** Another move changed its Space after the caller checked it. */
  | "moved"
  /** It is private. Private work never moves, so it never becomes public. */
  | "private"
  /** The Space is private. No Conversation moves into one. */
  | "private_space";

/** The Space that a move puts a Conversation in, with the Space's Lead. */
export interface SpaceMoveTarget {
  leadConversationId: string;
  spaceId: string;
}

/**
 * Put one public `thread`, a root or a Lead's child, in a public Space, or
 * take it out with null. In a Space it is a child of the Lead and stores its
 * parent's Destination and Location, so a Slack thread no longer gets its
 * replies. Out of one it is a root with its own Destination. Child agents
 * move with it. The caller checks who may move it out of `fromSpaceId`.
 */
export async function setConversationSpace(
  conversationId: string,
  target: SpaceMoveTarget | null,
  fromSpaceId: string | null,
): Promise<SpaceMoveRefusal | undefined> {
  const executor = getSqlExecutor();
  // A write reads the Conversation under this lock, so no write from before
  // the move puts back its old parent or Destination.
  return await withConversationMutationLock(
    executor,
    conversationId,
    async () => {
      const db = executor.db();
      const [moving] = await db
        .select({
          spaceId: rootSpaceIdSql(juniorConversations),
          visibility: juniorConversations.visibility,
        })
        .from(juniorConversations)
        .where(
          and(
            eq(juniorConversations.conversationId, conversationId),
            eq(juniorConversations.kind, "thread"),
            or(
              isNull(juniorConversations.parentConversationId),
              isLeadSql(juniorConversations.parentConversationId),
            ),
          ),
        )
        .limit(1);
      if (!moving) return "not_found";
      // The caller's membership check covers only the Space that it read.
      if (moving.spaceId !== fromSpaceId) return "moved";
      if (moving.visibility !== "public") return "private";
      let place: { destinationId: string | null; location: Location | null };
      if (target) {
        // A Space is its Lead, so the Lead's visibility is the Space's.
        const [lead] = await db
          .select({
            destinationId: juniorConversations.destinationId,
            location: juniorConversations.location,
            visibility: juniorConversations.visibility,
          })
          .from(juniorConversations)
          .where(
            and(
              eq(juniorConversations.conversationId, target.leadConversationId),
              eq(juniorConversations.kind, "lead"),
              eq(juniorConversations.spaceId, target.spaceId),
            ),
          );
        if (!lead) return "not_found";
        if (lead.visibility !== "public") return "private_space";
        place = lead;
      } else {
        const own = await upsertDestination(
          executor,
          destinationUpsertFromDestination({
            conversationId,
            destination: ownLocalDestination(conversationId),
            visibility: "public",
          }),
          Date.now(),
        );
        place = { destinationId: own?.id ?? null, location: null };
      }
      // Its work joins the tree of its new parent, the Lead's or its own,
      // and takes that tree's Destination and Location. Each statement
      // reads the subtree once, when it starts.
      await db
        .update(juniorConversations)
        .set({
          rootConversationId: target?.leadConversationId ?? conversationId,
          destinationId: place.destinationId,
          location: place.location,
          detailVersion: nextDetailVersion,
        })
        .where(
          inArray(
            juniorConversations.conversationId,
            sql`(select ${conversationSubtreeColumns.conversationId} from ${conversationSubtree([conversationId])})`,
          ),
        );
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
    },
  );
}
