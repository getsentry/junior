import { and, eq, isNull, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { nextDetailVersion } from "./detail-version";

const privacyRoot = alias(juniorConversations, "privacy_root");

/** Root conversation identity and its stored visibility. */
export interface RootConversationVisibility {
  rootConversationId: string;
  /** Null is private. */
  visibility: ConversationPrivacy | null;
}

interface PrivacyRoot {
  destinationId: string | null;
  rootConversationId: string;
}

/** Accept only a structurally valid persisted root as privacy authority. */
async function readRoot(
  executor: Pick<JuniorSqlDatabase, "db">,
  conversationId: string,
): Promise<PrivacyRoot | undefined> {
  const rows = await executor
    .db()
    .select({
      requestedConversationId: juniorConversations.conversationId,
      requestedParentConversationId: juniorConversations.parentConversationId,
      requestedRootConversationId: juniorConversations.rootConversationId,
      rootConversationId: privacyRoot.conversationId,
      rootDestinationId: privacyRoot.destinationId,
      rootParentConversationId: privacyRoot.parentConversationId,
      rootRootConversationId: privacyRoot.rootConversationId,
    })
    .from(juniorConversations)
    .leftJoin(
      privacyRoot,
      eq(privacyRoot.conversationId, juniorConversations.rootConversationId),
    )
    .where(eq(juniorConversations.conversationId, conversationId));
  const row = rows[0];
  return row !== undefined &&
    row.requestedRootConversationId !== null &&
    (row.requestedParentConversationId !== null ||
      row.requestedRootConversationId === row.requestedConversationId) &&
    row.rootConversationId === row.requestedRootConversationId &&
    row.rootRootConversationId === row.rootConversationId &&
    row.rootParentConversationId === null
    ? {
        destinationId: row.rootDestinationId,
        rootConversationId: row.rootConversationId,
      }
    : undefined;
}

/**
 * Resolve a conversation's privacy authority from its persisted root.
 *
 * Missing or structurally invalid root metadata fails closed. The share
 * lock from `lockRootDestination` gives callers that keep the transaction
 * open a stable decision. Locking the root row instead would deadlock two child writes that
 * both update the root later in their transactions.
 */
export async function resolveRootVisibility(
  executor: Pick<JuniorSqlDatabase, "db">,
  conversationId: string,
): Promise<RootConversationVisibility> {
  const root = await readRoot(executor, conversationId);
  if (!root) {
    return { rootConversationId: conversationId, visibility: null };
  }
  await lockRootDestination(executor, root.destinationId, "share");
  const [locked] = await executor
    .db()
    .select({ visibility: juniorConversations.visibility })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, root.rootConversationId));
  return {
    rootConversationId: root.rootConversationId,
    visibility: locked?.visibility ?? null,
  };
}

/**
 * True when the Conversation row of `table` is public. Every row of a tree
 * stores its root's visibility, so a query checks the row it reads. Missing
 * visibility is private. Use this instead of comparing the column.
 */
export function isPublicConversation(table: { visibility: AnyPgColumn }): SQL {
  return eq(table.visibility, "public");
}

/**
 * Give the rows of a tree that have no visibility yet the root's value,
 * once the root first gets one. Rows that have a value keep it.
 */
export async function fillMissingTreeVisibility(
  executor: Pick<JuniorSqlDatabase, "db">,
  rootConversationId: string,
  visibility: ConversationPrivacy,
): Promise<void> {
  const db = executor.db();
  const [root] = await db
    .select({ destinationId: juniorConversations.destinationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, rootConversationId));
  await lockRootDestination(executor, root?.destinationId ?? null, "update");
  await db
    .update(juniorConversations)
    .set({ visibility, detailVersion: nextDetailVersion })
    .where(
      and(
        eq(juniorConversations.rootConversationId, rootConversationId),
        isNull(juniorConversations.visibility),
      ),
    );
}

/**
 * Lock the root's Destination row. A new child copies its root's
 * visibility under the share lock, and every write to a tree's visibility
 * takes the update lock, so no child copies a value that a concurrent
 * write replaces. A root with no Destination has no row to lock.
 */
async function lockRootDestination(
  executor: Pick<JuniorSqlDatabase, "db">,
  destinationId: string | null,
  strength: "share" | "update",
): Promise<void> {
  if (!destinationId) return;
  await executor
    .db()
    .select({ id: juniorDestinations.id })
    .from(juniorDestinations)
    .where(eq(juniorDestinations.id, destinationId))
    .for(strength);
}
