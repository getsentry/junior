import { and, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
 * Missing or structurally invalid root metadata fails closed. A visibility
 * change locks the root's Destination row first (`setConversationVisibility`),
 * so a share lock on it gives callers that keep the transaction open a stable
 * decision. Locking the root row instead would deadlock two child writes that
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
  if (!root.destinationId) {
    return { rootConversationId: root.rootConversationId, visibility: null };
  }
  await executor
    .db()
    .select({ id: juniorDestinations.id })
    .from(juniorDestinations)
    .where(eq(juniorDestinations.id, root.destinationId))
    .for("share");
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
 * Make a root Conversation and its whole tree public or private
 * (`policies/conversation-access.md`). Only the root stores visibility, and
 * its children read it, so one write moves the tree. A Slack channel that
 * changes does not call this. Returns false when no root has the id.
 */
export async function setConversationVisibility(
  executor: Pick<JuniorSqlDatabase, "db">,
  rootConversationId: string,
  visibility: ConversationPrivacy,
): Promise<boolean> {
  const db = executor.db();
  const [root] = await db
    .select({ destinationId: juniorConversations.destinationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.conversationId, rootConversationId),
        isNull(juniorConversations.parentConversationId),
      ),
    );
  if (!root) return false;
  // `resolveRootVisibility` holds a share lock on this row while it decides.
  if (root.destinationId) {
    await db
      .select({ id: juniorDestinations.id })
      .from(juniorDestinations)
      .where(eq(juniorDestinations.id, root.destinationId))
      .for("update");
  }
  await db
    .update(juniorConversations)
    .set({ visibility, detailVersion: nextDetailVersion })
    .where(eq(juniorConversations.conversationId, rootConversationId));
  // A child's detail shows its root's visibility, so its version moves too.
  await db
    .update(juniorConversations)
    .set({ detailVersion: nextDetailVersion })
    .where(
      and(
        eq(juniorConversations.rootConversationId, rootConversationId),
        ne(juniorConversations.conversationId, rootConversationId),
      ),
    );
  return true;
}
