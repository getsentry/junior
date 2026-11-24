import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import type { Identity, User } from "@sentry/junior-plugin-api";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createConversationWorkQueueTestAdapter } from "../conversation-work";

// Shared setup for the Slack Inbox item card tests.

export const THREAD = "slack:C123:1712345.0001";
export const OTHER_THREAD = "slack:C456:1712345.0009";
// The Slack API mock gives every posted message this ts.
export const CARD_TS = "1700000000.100";

export const SHIP_REQUEST = {
  question: "Ship release 1.2.3?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Ship it", recommended: true }, { label: "Hold" }],
    },
  ],
};

/** Record a Slack thread Conversation that Ana takes part in. */
export async function slackThread(
  conversationId: string,
  visibility: "public" | "private",
): Promise<void> {
  const [, channelId, threadTs] = conversationId.split(":");
  await getConversationStore().recordActivity({
    // Ana takes part, so her agent can link the thread.
    actor: {
      email: "ana@example.com",
      platform: "slack",
      slackUserId: "U123",
      teamId: "T123",
    },
    conversationId,
    destination: {
      channelId: channelId!,
      platform: "slack",
      teamId: "T123",
      threadTs: threadTs!,
    },
    nowMs: 1,
    source: "slack",
    visibility,
  });
}

/** Add an Inbox item as the agent of one Conversation. */
export async function addItem(
  user: User,
  input: Record<string, unknown>,
  conversationId = THREAD,
) {
  const tool = createAddInboxItemTool(
    {
      conversationId,
      resolveActorIdentity: async () => ({
        identity: { id: `identity:${user.id}` } as Identity,
        user,
      }),
      source: { kind: "slack" } as any,
    },
    createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
  );
  return (await (tool as any).execute(input, {})) as {
    item: { assignees: string[]; id: string };
  };
}

/** The Inbox item changes that a Conversation recorded as handled Messages. */
export async function recordedChanges(conversationId: string) {
  return projectConversationMessages(
    await getConversationEventStore().loadMessageHistory(conversationId),
  ).flatMap((message) => message.meta?.reviewItemChanges ?? []);
}

/** The Block Kit blocks of one posted Slack message. */
export function blocksOf(
  call: { params: Record<string, unknown> } | undefined,
) {
  const blocks = call?.params["blocks"];
  return (typeof blocks === "string" ? JSON.parse(blocks) : blocks) as Array<{
    elements?: Array<{
      action_id?: string;
      style?: string;
      text?: unknown;
      url?: string;
      value?: string;
    }>;
    text?: string;
    type: string;
  }>;
}

/** The value of one button on a posted card, as Slack sends it back. */
export function buttonValue(
  call: { params: Record<string, unknown> } | undefined,
  actionId: string,
): string {
  const value = blocksOf(call)
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === actionId)?.value;
  if (!value) throw new Error(`no button ${actionId}`);
  return value;
}
