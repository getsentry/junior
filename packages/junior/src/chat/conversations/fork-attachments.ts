import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { getDb } from "@/chat/db";
import { juniorAttachments, juniorConversationEvents } from "@/db/schema";

type EventRow = typeof juniorConversationEvents.$inferSelect;

/** Copy retained attachment bytes and replace their ids in the copied events. */
export async function copyForkAttachments(args: {
  sourceConversationId: string;
  conversationId: string;
  rows: EventRow[];
  storage: AttachmentStorage;
  writtenKeys: string[];
}): Promise<EventRow[]> {
  if (!args.rows.length) return args.rows;
  const attachments = await getDb()
    .select()
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.conversationId, args.sourceConversationId),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  // The encoded agent history can contain attachment ids in text and tool
  // results as well as structured metadata. Replace only known stored ids.
  const payloads = args.rows.map((row) => JSON.stringify(row.payload));
  for (const attachment of attachments) {
    if (
      !payloads.some(
        (payload) =>
          payload.includes(attachment.id) ||
          (attachment.providerId && payload.includes(attachment.providerId)),
      )
    )
      continue;
    if (attachment.storageProvider !== args.storage.provider) {
      throw new Error("Attachment storage is unavailable for this fork.");
    }
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
    await getDb()
      .insert(juniorAttachments)
      .values({
        ...attachment,
        id,
        conversationId: args.conversationId,
        storageKey,
        createdAt: new Date(),
      });
    for (let i = 0; i < payloads.length; i++)
      payloads[i] = payloads[i]!.replaceAll(attachment.id, id);
  }
  return args.rows.map((row, index) => ({
    ...row,
    payload: JSON.parse(payloads[index]!) as EventRow["payload"],
  }));
}
