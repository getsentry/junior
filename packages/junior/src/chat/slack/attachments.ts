import type { Attachment, Message } from "chat";
import * as z from "zod";
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

/** A Slack message attachment with its Slack file id. */
export type SlackMessageAttachment = Attachment & { slackFileId?: string };

// The Slack adapter keeps the Slack event as `raw` and makes one Attachment
// for each `raw.files` entry, but it drops the file id. Read only the fields
// that pair them. Other event fields are Slack's and stay unread.
const slackEventFilesSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string().min(1),
        url_private: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

/**
 * Pair each attachment of a Slack message with its Slack file id from the
 * event's `files`, matched by private URL. A message whose `raw` is not a
 * Slack event gets no ids.
 */
export function readSlackMessageAttachments(
  message: Pick<Message, "attachments" | "raw">,
): SlackMessageAttachment[] {
  const parsed = slackEventFilesSchema.safeParse(message.raw);
  const files = parsed.success ? (parsed.data.files ?? []) : [];
  return message.attachments.map((attachment) => {
    const url = attachment.url ?? attachment.fetchMetadata?.url;
    const slackFileId = url
      ? files.find((file) => file.url_private === url)?.id
      : undefined;
    return slackFileId ? { ...attachment, slackFileId } : attachment;
  });
}
