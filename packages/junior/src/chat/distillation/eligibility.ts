import type { Actor } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { getConversationStore } from "@/chat/db";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { instructionActors } from "@/chat/conversations/provenance";
import { readActorIdentity } from "@/chat/plugins/viewer";

/** Restrict a personal rollout to one linked user across the whole Conversation. */
export function allowsDistillationForUsers(
  allowedUserIds: readonly string[],
  currentUserId: string | undefined,
  instructionUserIds: readonly (string | undefined)[],
): boolean {
  if (allowedUserIds.length === 0) return true;
  return (
    currentUserId !== undefined &&
    allowedUserIds.includes(currentUserId) &&
    instructionUserIds.length > 0 &&
    instructionUserIds.every((userId) => userId === currentUserId)
  );
}

/** Check the current Actor and all authored instructions before observing or replacing history. */
export async function mayDistillConversation(
  conversationId: string,
  actor: Actor | undefined,
  provenance: readonly ConversationMessageProvenance[],
): Promise<boolean> {
  const allowed = botConfig.contextDistillationUserIds;
  if (allowed.length === 0) return true;
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
  const currentUserId = (await readActorIdentity(actor))?.user?.id;
  if (!currentUserId || !allowed.includes(currentUserId)) return false;
  const instructionUserIds = await Promise.all(
    instructionActors([...provenance]).map(
      async (author) => (await readActorIdentity(author))?.user?.id,
    ),
  );
  return allowsDistillationForUsers(allowed, currentUserId, instructionUserIds);
}
