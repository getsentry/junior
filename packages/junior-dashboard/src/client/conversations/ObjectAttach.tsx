import {
  attachObjectLinkResponseSchema,
  type ConversationDetailReport,
} from "@sentry/junior/api/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { post } from "../http";
import { conversationDetailQueryKey } from "./queries";

type ObjectAttachTarget = {
  conversationId: string;
  /** Links that the Conversation has, without a trailing slash. */
  links: ReadonlySet<string>;
};

const ObjectAttachContext = createContext<ObjectAttachTarget | undefined>(
  undefined,
);

// The API drops only a trailing slash when it compares links.
function linkKey(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Let the live object cards of one Conversation attach their object to it.
 * Only a participant can attach, and a Task takes no input from people.
 */
export function ObjectAttachProvider(props: {
  children: ReactNode;
  conversation: ConversationDetailReport;
}) {
  const { annotations, conversationId, isParticipant, kind } =
    props.conversation;
  const target = useMemo(
    () =>
      isParticipant && kind !== "task"
        ? {
            conversationId,
            links: new Set(
              (annotations ?? []).flatMap((annotation) =>
                annotation.url ? [linkKey(annotation.url)] : [],
              ),
            ),
          }
        : undefined,
    [annotations, conversationId, isParticipant, kind],
  );
  return (
    <ObjectAttachContext.Provider value={target}>
      {props.children}
    </ObjectAttachContext.Provider>
  );
}

/**
 * Attach the object of a live card to the Conversation, as a link. The API
 * checks again that the viewer can see the object and write to the
 * Conversation.
 */
export function ObjectAttachAction(props: { url: string }) {
  const target = useContext(ObjectAttachContext);
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: (id: string) =>
      post(
        attachObjectLinkResponseSchema,
        `/api/conversations/${encodeURIComponent(id)}/annotations`,
        { url: props.url },
      ),
    onSuccess: (_result, id) =>
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(id),
      }),
  });
  if (!target) return null;
  if (target.links.has(linkKey(props.url)) || attach.isSuccess) {
    return <span className="text-dashboard-text-muted">Attached</span>;
  }
  return (
    <span className="flex items-center gap-2">
      {attach.isError && (
        <span className="text-dashboard-text-muted">Could not attach.</span>
      )}
      <Button
        disabled={attach.isPending}
        onClick={() => attach.mutate(target.conversationId)}
        type="button"
        variant="outline"
      >
        Attach
      </Button>
    </span>
  );
}
