import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackAutomationCard } from "./automation-card";
import type { SlackMessageBlock } from "./footer";

/** Block Kit content inside Slack's native attachment container. */
export interface SlackMessageAttachment {
  blocks: SlackMessageBlock[];
  fallback: string;
  color?: string;
}

/** Select the Slack attachment renderer for a built-in card. */
export function renderSlackCard(card: MessageCard): SlackMessageAttachment {
  switch (card.kind) {
    case "automation":
      return renderSlackAutomationCard(card);
  }
}
