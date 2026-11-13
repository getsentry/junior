/**
 * Review desk inputs: a person acts on an open item from the dashboard.
 * Also reads the items that core adds for Tool approvals.
 */
import type { Hono } from "hono";
import { getDb } from "@/chat/db";
import { getReviewItem } from "@/chat/review-items/store";
import { listToolApprovals } from "@/chat/tool-approvals/log";
import type { JuniorApiEnv } from "@/api/route";
import { actOnReviewItem } from "./dashboard-requests";
import type { ReviewItemActionInput } from "./inputs";
import { insertWebReviewItem } from "./insert";

/**
 * Store the open item that an earlier Turn of the web Conversation added,
 * then submit or dismiss it through the dashboard API as `viewerEmail`.
 */
export async function actOnWebReviewItem(
  api: Hono<JuniorApiEnv>,
  input: ReviewItemActionInput,
  conversation: { conversationId: string; viewerEmail: string },
): Promise<void> {
  const { id } = await insertWebReviewItem({ ...input, ...conversation });
  await actOnReviewItem(api, {
    ...input,
    id,
    viewerEmail: conversation.viewerEmail,
  });
}

/**
 * The open Tool approvals of one Conversation: the calls that core stored
 * in its event log and that have not ended, with their item's state.
 */
export async function openToolApprovals(conversationId: string) {
  const db = getDb();
  const open = (await listToolApprovals(conversationId)).filter(
    (approval) => !approval.end,
  );
  return await Promise.all(
    open.map(async (approval) => ({
      itemStatus: (await getReviewItem(db, approval.reviewItemId))?.status,
      status: approval.claimTurnId ? "running" : "pending",
      toolName: approval.toolName,
    })),
  );
}
