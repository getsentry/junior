/**
 * Inbox inputs: a person acts on an open item from the dashboard.
 */
import type { Hono } from "hono";
import type { JuniorApiEnv } from "@/api/route";
import { actOnInboxItem } from "./dashboard-requests";
import type { InboxItemActionInput } from "./inputs";
import { insertWebInboxItem } from "./insert";

/**
 * Store the open item that an earlier Turn of the web Conversation added,
 * then submit or dismiss it through the dashboard API as `viewerEmail`.
 */
export async function actOnWebInboxItem(
  api: Hono<JuniorApiEnv>,
  input: InboxItemActionInput,
  conversation: { conversationId: string; viewerEmail: string },
): Promise<void> {
  const { id } = await insertWebInboxItem({ ...input, ...conversation });
  await actOnInboxItem(api, {
    ...input,
    id,
    viewerEmail: conversation.viewerEmail,
  });
}
