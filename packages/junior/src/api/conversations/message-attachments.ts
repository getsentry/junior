import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ConversationEvent } from "@/chat/conversations/history";
import { readMessageAttachments } from "@/chat/attachments/input";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";

/** Resolve saved Slack file references without exposing private storage details. */
export async function hydrateMessageAttachments(
  db: JuniorSqlDatabase,
  conversationId: string,
  events: ConversationEvent[],
): Promise<void> {
  const messages = events.flatMap((event) =>
    event.data.type === "message" ? [event.data] : [],
  );
  const ids = [
    ...new Set(messages.flatMap((message) => slackFileIds(message.meta))),
  ];
  if (!ids.length) return;
  const attachments = await db
    .db()
    .select({
      id: juniorAttachments.id,
      providerId: juniorAttachments.providerId,
      bytes: juniorAttachments.bytes,
      contentType: juniorAttachments.contentType,
      filename: juniorAttachments.filename,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.conversationId, conversationId),
        eq(juniorAttachments.provider, "slack"),
        inArray(juniorAttachments.providerId, ids),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  const byFileId = new Map(
    attachments.map(({ providerId, ...attachment }) => [
      providerId,
      attachment,
    ]),
  );
  for (const message of messages) {
    const stored = readMessageAttachments(message.meta?.attachments);
    const matched = slackFileIds(message.meta).flatMap((id) => {
      const attachment = byFileId.get(id);
      return attachment ? [attachment] : [];
    });
    if (matched.length)
      message.meta = { ...message.meta, attachments: [...stored, ...matched] };
  }
}

function slackFileIds(meta: Record<string, unknown> | undefined): string[] {
  const ids = meta?.slackFileIds ?? meta?.imageFileIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}
