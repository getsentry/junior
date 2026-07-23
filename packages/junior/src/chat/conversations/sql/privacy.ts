import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

const privacyRoot = alias(juniorConversations, "privacy_root");

interface PrivacyRootCandidate {
  destinationId: string;
  rootConversationId: string;
}

/** Root conversation identity and its normalized destination visibility. */
export interface RootConversationVisibility {
  rootConversationId: string;
  visibility: JuniorDestinationVisibility | null;
}

/** Accept only a structurally valid persisted root as privacy authority. */
async function readRootCandidate(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<PrivacyRootCandidate | undefined> {
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
  return row?.requestedRootConversationId !== null &&
    (row?.requestedParentConversationId !== null ||
      row?.requestedRootConversationId === row?.requestedConversationId) &&
    row?.rootConversationId === row.requestedRootConversationId &&
    row.rootRootConversationId === row.rootConversationId &&
    row.rootParentConversationId === null &&
    row.rootDestinationId !== null
    ? {
        destinationId: row.rootDestinationId,
        rootConversationId: row.rootConversationId,
      }
    : undefined;
}

async function readCandidateVisibility(
  executor: JuniorSqlDatabase,
  candidate: PrivacyRootCandidate,
): Promise<RootConversationVisibility> {
  const destinations = await executor
    .db()
    .select({ visibility: juniorDestinations.visibility })
    .from(juniorDestinations)
    .where(eq(juniorDestinations.id, candidate.destinationId))
    .for("share");
  return {
    rootConversationId: candidate.rootConversationId,
    visibility: destinations[0]?.visibility ?? null,
  };
}

/**
 * Resolve a conversation's privacy authority from its persisted root.
 *
 * Missing or structurally invalid root metadata fails closed. The root
 * destination is locked so callers that keep the transaction open receive a
 * stable visibility decision.
 */
export async function resolveRootVisibility(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<RootConversationVisibility> {
  const candidate = await readRootCandidate(executor, conversationId);
  if (!candidate) {
    return { rootConversationId: conversationId, visibility: null };
  }

  return readCandidateVisibility(executor, candidate);
}
