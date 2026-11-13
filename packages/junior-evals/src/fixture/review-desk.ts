/**
 * Review desk inputs: a person acts on an open item from the dashboard.
 * Also reads the items that core adds for Tool approvals.
 */
import type { Hono } from "hono";
import { getDb } from "@/chat/db";
import { getReviewItem } from "@/chat/review-items/store";
import { listToolApprovals } from "@/chat/tool-approvals";
import type { JuniorApiEnv } from "@/api/route";
import { actOnReviewItem } from "./dashboard-requests";
import type { ReviewItemActionInput, ToolApprovalAnswerInput } from "./inputs";
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
 * Answer the one open Tool approval of the Conversation through the
 * dashboard API as `viewerEmail`, the person who asked.
 */
export async function answerToolApproval(
  api: Hono<JuniorApiEnv>,
  input: ToolApprovalAnswerInput,
  conversation: { conversationId: string; viewerEmail: string },
): Promise<void> {
  const open = (await listToolApprovals(conversation.conversationId)).filter(
    (approval) => !approval.decision,
  );
  if (open.length !== 1) {
    throw new Error(
      `toolApprovalAnswer() needs one open Tool approval, found ${open.length}`,
    );
  }
  await actOnReviewItem(api, {
    action: "submit",
    id: open[0]!.reviewItemId,
    values: { decision: [input.decision] },
    viewerEmail: conversation.viewerEmail,
  });
}

/**
 * The open Tool approvals of one Conversation: the calls that core stored
 * in its event log and that have no decision yet, with their item's state.
 */
export async function openToolApprovals(conversationId: string) {
  const db = getDb();
  const open = (await listToolApprovals(conversationId)).filter(
    (approval) => !approval.decision,
  );
  return await Promise.all(
    open.map(async (approval) => ({
      itemStatus: (await getReviewItem(db, approval.reviewItemId))?.status,
      toolName: approval.toolName,
    })),
  );
}
