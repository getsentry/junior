import type { ConversationMessage } from "@/chat/state/conversation";

/**
 * Build unique non-bot participant metadata for prompt mention injection.
 */
export function buildThreadParticipants(
  messages: ConversationMessage[],
): Array<{ userId?: string; userName?: string; fullName?: string }> {
  const seen = new Set<string>();
  const participants: Array<{
    userId?: string;
    userName?: string;
    fullName?: string;
  }> = [];

  for (const message of messages) {
    const { userId, userName, fullName } = message.author ?? {};
    if (!userId || message.author?.isBot) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    participants.push({ userId, userName, fullName });
  }

  return participants;
}
