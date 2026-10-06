import type { Actor } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { botConfig } from "@/chat/config";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { instructionActors } from "@/chat/conversations/provenance";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { juniorIdentities } from "@/db/schema";
import { readDistillationPreference } from "./preference";

/** Restrict a personal rollout to one linked user across the whole Conversation. */
export function allowsDistillationForUsers(
  allowedUserIds: readonly string[],
  currentUserId: string | undefined,
  instructionUserIds: readonly (string | undefined)[],
): boolean {
  return (
    currentUserId !== undefined &&
    (allowedUserIds.length === 0 || allowedUserIds.includes(currentUserId)) &&
    instructionUserIds.length > 0 &&
    instructionUserIds.every((userId) => userId === currentUserId)
  );
}

async function linkedUserId(actor: Actor): Promise<string | undefined> {
  if (actor.platform !== "web") {
    return (await readActorIdentity(actor))?.user?.id;
  }
  const email = actor.email && normalizeIdentityEmail(actor.email);
  if (!email || webActorFromEmail(email).userId !== actor.userId) {
    return undefined;
  }
  const [row] = await getDb()
    .select({ userId: juniorIdentities.userId })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.provider, "junior"),
        eq(juniorIdentities.providerTenantId, ""),
        eq(juniorIdentities.providerSubjectId, email),
        eq(juniorIdentities.emailVerified, true),
      ),
    )
    .limit(1);
  return row?.userId ?? undefined;
}

/** Check the current Actor and all authored instructions before observing or replacing history. */
export async function mayDistillConversation(
  conversationId: string,
  actor: Actor | undefined,
  provenance: readonly ConversationMessageProvenance[],
): Promise<boolean> {
  const allowed = botConfig.contextDistillationUserIds;
  const conversation = await getConversationStore().get({ conversationId });
  if (conversation?.visibility !== "private") return false;
  if (
    !actor ||
    provenance.some(
      (entry) => entry.authority === "instruction" && !entry.actor,
    )
  ) {
    return false;
  }
  const currentUserId = await linkedUserId(actor);
  if (!currentUserId || !(await readDistillationPreference(currentUserId))) {
    return false;
  }
  const instructionUserIds = await Promise.all(
    instructionActors([...provenance]).map(linkedUserId),
  );
  return allowsDistillationForUsers(allowed, currentUserId, instructionUserIds);
}
