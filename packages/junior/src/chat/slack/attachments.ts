import { and, eq, inArray, isNull } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorAttachments } from "@/db/schema";

/** Save the vision summary for a stored Slack attachment. */
export async function recordSlackAttachment(args: {
  attachmentId: string;
  conversationId: string;
  db: JuniorSqlDatabase;
  visionSummary: string;
}): Promise<void> {
  await args.db
    .db()
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
}): Promise<Array<{ id: string; providerId: string | null }>> {
  if (args.providerIds.length === 0) return [];
  return await args.db
    .db()
    .select({
      id: juniorAttachments.id,
      providerId: juniorAttachments.providerId,
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
