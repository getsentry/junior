import type {
  ConversationFeedItem,
  ConversationFind,
} from "@sentry/junior/api/schema";

import { readMockConversationFeed } from "./fixtures";

const MAX_MATCHES = 5;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
}

/**
 * Stand in for the model find with word overlap on titles and Briefs. It
 * shows the palette states with no model. It is not a check of model
 * ranking.
 */
export function findMockConversations(description: string): ConversationFind {
  const asked = words(description);
  const flatten = (items: ConversationFeedItem[]): ConversationFeedItem[] =>
    items.flatMap(({ threads, ...item }) => [item, ...flatten(threads ?? [])]);
  const candidates = flatten([
    ...readMockConversationFeed(undefined, "active").conversations,
    ...readMockConversationFeed(undefined, "archived").conversations,
  ]);
  const scored = candidates.flatMap((conversation) => {
    const text = [
      conversation.displayTitle,
      conversation.brief?.intent,
      conversation.brief?.summary,
    ].join(" ");
    const shared = [...words(text)].filter((word) => asked.has(word));
    return shared.length
      ? [
          {
            conversation,
            reason: `Mentions ${shared.slice(0, 3).join(", ")}`,
            score: shared.length,
          },
        ]
      : [];
  });
  return {
    matches: scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES)
      .map(({ conversation, reason }) => ({ conversation, reason })),
  };
}
