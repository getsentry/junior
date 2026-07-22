import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import { participantMatchColumn } from "@/chat/conversations/participant";

const conversationEventColumns = getTableColumns(juniorConversationEvents);
const privacyRoot = alias(juniorConversations, "privacy_root");
const privacyRootDestination = alias(
  juniorDestinations,
  "privacy_root_destination",
);
const privacyRootIdentity = alias(juniorIdentities, "privacy_root_identity");

interface PrivacyRootCandidate {
  destinationId: string;
  rootConversationId: string;
}

/** Root conversation identity and its normalized destination visibility. */
export interface RootConversationVisibility {
  rootConversationId: string;
  visibility: JuniorDestinationVisibility | null;
}

interface ConversationEventPrivacyAuthority {
  isParticipant: boolean;
  rootConversationId: string | null;
  visibility: JuniorDestinationVisibility | null;
}

type ConversationEventPrivacySnapshot = ConversationEventPrivacyAuthority & {
  events: Array<typeof juniorConversationEvents.$inferSelect>;
};

/**
 * Read selected event rows and their root privacy authority in one SQL snapshot.
 */
export async function readConversationEventPrivacySnapshot(
  executor: JuniorSqlDatabase,
  args: {
    authorizedUserEmail?: string;
    conversationId: string;
    eventTypes: readonly string[];
  },
): Promise<ConversationEventPrivacySnapshot | undefined> {
  const rows = await executor
    .db()
    .select({
      requestedConversationId: juniorConversations.conversationId,
      requestedParentConversationId: juniorConversations.parentConversationId,
      requestedRootConversationId: juniorConversations.rootConversationId,
      rootConversationId: privacyRoot.conversationId,
      rootParentConversationId: privacyRoot.parentConversationId,
      rootRootConversationId: privacyRoot.rootConversationId,
      visibility: privacyRootDestination.visibility,
      isParticipant: participantMatchColumn(args.authorizedUserEmail, {
        emailNormalized: privacyRootIdentity.emailNormalized,
        emailVerified: privacyRootIdentity.emailVerified,
      }),
      event: {
        ...conversationEventColumns,
        // Replacement history is model context, never dashboard report data.
        // Keep the required replacement field while redacting its contents.
        payload: sql<Record<string, unknown>>`case
          when ${juniorConversationEvents.type} in ('compaction', 'handoff')
          then jsonb_set(
            ${juniorConversationEvents.payload},
            '{replacementHistory}',
            '[]'::jsonb
          )
          else ${juniorConversationEvents.payload}
        end`,
      },
    })
    .from(juniorConversations)
    .leftJoin(
      privacyRoot,
      eq(privacyRoot.conversationId, juniorConversations.rootConversationId),
    )
    .leftJoin(
      privacyRootDestination,
      eq(privacyRootDestination.id, privacyRoot.destinationId),
    )
    .leftJoin(
      privacyRootIdentity,
      eq(privacyRootIdentity.id, privacyRoot.actorIdentityId),
    )
    .leftJoin(
      juniorConversationEvents,
      and(
        eq(juniorConversationEvents.conversationId, args.conversationId),
        inArray(juniorConversationEvents.type, [...args.eventTypes]),
      ),
    )
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .orderBy(asc(juniorConversationEvents.seq));
  const first = rows[0];
  if (!first) return undefined;
  const hasValidRoot =
    first.requestedRootConversationId !== null &&
    (first.requestedParentConversationId !== null ||
      first.requestedRootConversationId === first.requestedConversationId) &&
    first.rootConversationId === first.requestedRootConversationId &&
    first.rootParentConversationId === null &&
    first.rootRootConversationId === first.rootConversationId;

  return {
    isParticipant: hasValidRoot ? first.isParticipant : false,
    rootConversationId: hasValidRoot ? first.rootConversationId : null,
    visibility: hasValidRoot ? first.visibility : null,
    events: rows.flatMap(({ event }) => (event ? [event] : [])),
  };
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
