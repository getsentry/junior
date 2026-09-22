import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackAutomationCard } from "./automation-card";
import type { SlackMessageBlock } from "./footer";

/** Select the Slack renderer for a built-in card. */
export function renderSlackCard(card: MessageCard): {
  blocks: SlackMessageBlock[];
  text: string;
} {
  switch (card.kind) {
    case "automation":
      return renderSlackAutomationCard(card);
  }
}
