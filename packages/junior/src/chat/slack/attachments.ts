import type { Attachment } from "chat";
import type { MessageAttachment } from "@/chat/attachments/input";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";
import { conversationDetailTouch } from "@/chat/conversations/sql/detail-version";

/** Save the vision summary for a stored Slack attachment. */
export async function recordSlackAttachment(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
  visionSummary: string;
}): Promise<void> {
  const db = args.db.db();
  await db
    .with(conversationDetailTouch(db, [args.conversationId]))
    .update(juniorAttachments)
    .set({ visionSummary: args.visionSummary })
    .where(
      and(
        eq(juniorAttachments.id, args.attachmentId),
        eq(juniorAttachments.conversationId, args.conversationId),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
}

/** Read a saved vision summary for one live attachment. */
export async function readAttachmentVisionSummary(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
}): Promise<string | null | undefined> {
  const [row] = await args.db
    .db()
    .select({ visionSummary: juniorAttachments.visionSummary })
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.id, args.attachmentId),
        eq(juniorAttachments.conversationId, args.conversationId),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
  return row?.visionSummary;
}

/** Match live conversation attachments to Slack file ids. */
export async function matchSlackAttachments(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  providerIds: string[];
}): Promise<Array<MessageAttachment & { providerId: string | null }>> {
  if (args.providerIds.length === 0) return [];
  return await args.db
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
        eq(juniorAttachments.conversationId, args.conversationId),
        eq(juniorAttachments.provider, "slack"),
        inArray(juniorAttachments.providerId, args.providerIds),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
}

/**
 * Fingerprint the live Slack attachments that `matchSlackAttachments` can
 * return for a Conversation. It changes when one is stored or deleted, so a
 * reader can tell that stored messages may now show other files.
 */
export function slackAttachmentsVersionQuery(
  db: JuniorDatabase,
  conversationId: string,
) {
  return db
    .select({
      version: sql<string>`coalesce(md5(string_agg(${juniorAttachments.id}, ',' order by ${juniorAttachments.id})), '')`,
    })
    .from(juniorAttachments)
    .where(
      and(
        eq(juniorAttachments.conversationId, conversationId),
        eq(juniorAttachments.provider, "slack"),
        isNull(juniorAttachments.deleteRequestedAt),
      ),
    );
}

/** Read the Slack file identity retained by the Chat SDK. */
export function getSlackFileId(attachment: Attachment): string | undefined {
  const metadataId = attachment.fetchMetadata?.fileId;
  if (metadataId) return metadataId;
  const match = (attachment.url ?? attachment.fetchMetadata?.url ?? "").match(
    /(?:^|[-/])(F[A-Z0-9]+)(?:[-/]|$)/i,
  );
  return match?.[1];
}
