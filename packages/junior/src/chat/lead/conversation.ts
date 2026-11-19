/**
 * The Lead of one person: their private Conversation that finds, starts, and
 * steers their other Conversations. Only web creates a Lead, so its root
 * Actor is the web Identity of its User, and a unique index keeps one Lead
 * for each Identity.
 */
import { randomUUID } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, eq, sql } from "drizzle-orm";
import type { Conversation } from "@/chat/conversations/store";
import {
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { isPostgresErrorCode } from "@/db/postgres-error";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";

// Postgres `unique_violation`: another request created the Lead first.
const UNIQUE_VIOLATION = "23505";

const LEAD_TITLE = "Lead";

type LeadUser = Pick<User, "displayName" | "email" | "id">;

async function findLead(identityId: string): Promise<Conversation | undefined> {
  const [row] = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.kind, "lead"),
        eq(juniorConversations.actorIdentityId, identityId),
      ),
    )
    .limit(1);
  return row
    ? await getConversationStore().get({ conversationId: row.conversationId })
    : undefined;
}

/** Return the Lead of one User, and create it on first use. */
export async function getLeadConversation(
  user: LeadUser,
): Promise<Conversation> {
  const actor = webActorFromUser(user);
  const identityId = await resolveActorIdentityId(getSqlExecutor(), actor);
  if (!identityId) throw new Error("A Lead needs a web Identity");
  const existing = await findLead(identityId);
  if (existing) return existing;
  try {
    await recordWebConversationActivity({
      actor,
      conversationId: `local:web:${randomUUID()}`,
      nowMs: Date.now(),
      rootKind: "lead",
      rootTitle: LEAD_TITLE,
      rootVisibility: "private",
    });
  } catch (error) {
    if (!isPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;
  }
  const created = await findLead(identityId);
  if (!created) throw new Error("The Lead was not saved");
  return created;
}

/**
 * Return the User of a Lead: the person whose Conversations it steers.
 * Returns nothing for a Conversation that is not a Lead.
 */
export async function readLeadUser(
  conversationId: string,
): Promise<LeadUser | undefined> {
  const [row] = await getDb()
    .select({
      displayName: juniorUsers.displayName,
      email: juniorUsers.primaryEmail,
      id: juniorUsers.id,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorConversations.conversationId, conversationId),
        eq(juniorConversations.kind, "lead"),
      ),
    )
    .limit(1);
  return row
    ? {
        id: row.id,
        email: row.email,
        ...(row.displayName ? { displayName: row.displayName } : undefined),
      }
    : undefined;
}

/**
 * Return whether the person of a Lead is a Participant of one root
 * Conversation. False when the sender is not a Lead.
 */
export async function leadPersonParticipates(args: {
  leadConversationId: string;
  rootConversationId: string;
}): Promise<boolean> {
  const [row] = await getDb()
    .select({ one: sql`1` })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(
      juniorConversationParticipants,
      and(
        eq(juniorConversationParticipants.userId, juniorIdentities.userId),
        eq(
          juniorConversationParticipants.rootConversationId,
          args.rootConversationId,
        ),
      ),
    )
    .where(
      and(
        eq(juniorConversations.conversationId, args.leadConversationId),
        eq(juniorConversations.kind, "lead"),
      ),
    )
    .limit(1);
  return row !== undefined;
}
