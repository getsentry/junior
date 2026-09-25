import { renderSlackObjectCard } from "./object-card";
import type { SlackEntity } from "./work-object";
import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackAutomationCard } from "./automation-card";

/** Text is the accessible fallback, or the visible content without an entity. */
export interface SlackCard {
  entity: SlackEntity | null;
  text: string;
}

/** Select the Slack object renderer for a built-in card. */
export function renderSlackCard(
  card: MessageCard,
  conversationId: string,
): SlackCard {
  switch (card.kind) {
    case "object":
      return renderSlackObjectCard(card, conversationId);
    case "automation":
      return renderSlackAutomationCard(card);
  }
}
