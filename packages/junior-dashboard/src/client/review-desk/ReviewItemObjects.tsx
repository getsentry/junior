import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { conversationDetailQueryOptions } from "../conversations/queries";
import { KnownObjectsProvider } from "../display-text/DisplayText";

/**
 * Let Review item text show the objects saved on the Conversation that added
 * the item. It reads that Conversation's detail from the cache only, so a
 * Conversation that the page did not load shows plain links.
 */
export function ReviewItemObjects(props: {
  children: ReactNode;
  conversationId: string;
}) {
  const annotations = useQuery({
    ...conversationDetailQueryOptions(props.conversationId),
    enabled: false,
  }).data?.annotations;
  return (
    <KnownObjectsProvider annotations={annotations}>
      {props.children}
    </KnownObjectsProvider>
  );
}
