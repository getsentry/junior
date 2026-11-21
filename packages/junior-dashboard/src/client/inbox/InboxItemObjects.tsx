import { useQuery } from "@tanstack/react-query";
import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import { conversationDetailQueryOptions } from "../conversations/queries";
import { KnownObjectsProvider } from "../display-text/DisplayText";

/**
 * Let Inbox item text show the objects saved on the Conversation that owns
 * the item. It reads that Conversation's detail from the cache only, so a
 * Conversation that the page did not load, or an item that no Conversation
 * owns, shows plain links, or the `cards` that the caller already has.
 */
export function InboxItemObjects(props: {
  cards?: readonly OwnedObjectAnnotation[];
  children: ReactNode;
  conversationId: string | undefined;
}) {
  const annotations = useQuery({
    ...conversationDetailQueryOptions(props.conversationId),
    enabled: false,
  }).data?.annotations;
  return (
    <KnownObjectsProvider annotations={annotations} cards={props.cards}>
      {props.children}
    </KnownObjectsProvider>
  );
}
