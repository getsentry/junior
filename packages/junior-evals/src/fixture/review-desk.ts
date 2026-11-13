/**
 * Review desk inputs: a person acts on an open item from the dashboard.
 */
import type { Hono } from "hono";
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
