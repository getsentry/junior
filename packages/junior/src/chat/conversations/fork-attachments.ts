import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { getDb } from "@/chat/db";
import { juniorAttachments, juniorConversationEvents } from "@/db/schema";

type EventRow = typeof juniorConversationEvents.$inferSelect;

/** Copy bytes outside SQL locks; publish metadata only with the completed fork. */
export async function copyForkAttachments(args: {
  sourceConversationId: string;
  conversationId: string;
  rows: EventRow[];
  storage: AttachmentStorage;
  writtenKeys: string[];
}): Promise<Array<typeof juniorAttachments.$inferInsert>> {
  if (!args.rows.length) return [];
  const attachments = await getDb()
    .select()
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.conversationId, args.sourceConversationId),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  // Inspect opaque history only to find referenced files. Never rewrite it.
  const payloads = args.rows.map((row) => JSON.stringify(row.payload));
  const copies: Array<typeof juniorAttachments.$inferInsert> = [];
  for (const attachment of attachments) {
    const historyIds = [...(attachment.historyIds ?? []), attachment.id];
    if (
      !payloads.some(
        (payload) =>
          historyIds.some((id) => payload.includes(id)) ||
          (attachment.providerId && payload.includes(attachment.providerId)),
      )
    )
      continue;
    if (attachment.storageProvider !== args.storage.provider)
      throw new Error("Attachment storage is unavailable for this fork.");
    const body = await args.storage.get(attachment.storageKey);
    if (!body)
      throw new Error("An attachment is no longer available for this fork.");
    const id = randomUUID();
    const storageKey = `conversations/${args.conversationId}/attachments/${id}/${attachment.filename}`;
    args.writtenKeys.push(storageKey);
    await args.storage.put({
      key: storageKey,
      contentType: attachment.contentType,
      body: Buffer.from(await new Response(body).arrayBuffer()),
    });
    copies.push({
      ...attachment,
      id,
      historyIds,
      conversationId: args.conversationId,
      storageKey,
      createdAt: new Date(),
    });
  }
  return copies;
}
