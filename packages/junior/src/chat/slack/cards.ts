import { renderSlackObjectCard } from "./object-card";
import type { ChatPostMessageArguments } from "@slack/web-api";
import type { MessageCard } from "@/chat/conversations/cards";
import { renderSlackAutomationCard } from "./automation-card";

/** Slack owns the layout of these native object previews. */
export type SlackEntity = NonNullable<
  NonNullable<ChatPostMessageArguments["metadata"]>["entities"]
>[number];

/** Text is the accessible fallback, or the visible content without an entity. */
export interface SlackCard {
  entity: SlackEntity | null;
  text: string;
}

/** Select the Slack object renderer for a built-in card. */
export function renderSlackCard(card: MessageCard): SlackCard {
  switch (card.kind) {
    case "object":
      return renderSlackObjectCard(card);
    case "automation":
      return renderSlackAutomationCard(card);
  }
}
