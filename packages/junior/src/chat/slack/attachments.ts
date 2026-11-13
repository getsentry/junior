import type { Attachment } from "chat";
import type { MessageAttachment } from "@/chat/attachments/input";
import {
  AttachmentSourceUnavailableError,
  type ReadAttachmentSource,
} from "@/chat/attachments/source";
import {
  readPrivateSlackFile,
  SlackActionError,
  streamPrivateSlackFile,
} from "@/chat/slack/client";
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
  const rows = await args.db
    .db()
    .select({
      id: juniorAttachments.id,
      providerId: juniorAttachments.providerId,
      bytes: juniorAttachments.bytes,
      contentType: juniorAttachments.contentType,
      filename: juniorAttachments.filename,
      storageKey: juniorAttachments.storageKey,
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
  return rows.map(({ storageKey, ...row }) =>
    storageKey === null ? { ...row, pending: true as const } : row,
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
      // A pending file changes the version again when its first load stores it.
      version: sql<string>`coalesce(md5(string_agg(${juniorAttachments.id} || case when ${juniorAttachments.storageKey} is null then ':pending' else '' end, ',' order by ${juniorAttachments.id})), '')`,
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
  // Slack file ids are upper case. Matching case-insensitively would take
  // the `files` segment of `/files-pri/T…-F…/name` as the id.
  const match = (attachment.url ?? attachment.fetchMetadata?.url ?? "").match(
    /(?:^|[-/])(F[A-Z0-9]+)(?:[-/]|$)/,
  );
  return match?.[1];
}

/**
 * Look up a Slack file that Junior recorded without downloading it.
 *
 * Uses the installation token that the current Slack turn binds.
 */
export const readSlackAttachmentSource: ReadAttachmentSource = async (
  source,
) => {
  const unavailable = (cause?: unknown) =>
    new AttachmentSourceUnavailableError(
      "The Slack file was deleted, or Junior can no longer access it.",
      { cause },
    );
  if (source.provider !== "slack") throw unavailable();
  const file = await readPrivateSlackFile(source.id);
  if (!file) throw unavailable();
  return {
    bytes: file.bytes,
    open: async () => {
      try {
        return await streamPrivateSlackFile(file.url);
      } catch (error) {
        // Slack answers 403 or 404 for a file that was deleted or unshared.
        if (
          error instanceof SlackActionError &&
          (error.code === "not_found" || error.statusCode === 403)
        ) {
          throw unavailable(error);
        }
        throw error;
      }
    },
  };
};
