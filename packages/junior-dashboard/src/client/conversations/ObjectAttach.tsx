import {
  attachObjectLinkResponseSchema,
  type ConversationDetailReport,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { post } from "../http";
import { conversationDetailQueryKey } from "./queries";

type ObjectAttachTarget = {
  conversationId: string;
  /**
   * The links and objects that the Conversation has. A link has no trailing
   * slash. An object is `plugin:key`, so another link to it also counts.
   */
  attached: ReadonlySet<string>;
};

const ObjectAttachContext = createContext<ObjectAttachTarget | undefined>(
  undefined,
);

// The API drops only a trailing slash when it compares links, and also
// compares the plugin and key of the object.
function linkKey(url: string): string {
  return `link:${url.replace(/\/+$/, "")}`;
}

function objectKey(object: { key: string; plugin: string }): string {
  return `object:${object.plugin}:${object.key}`;
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
            attached: new Set(
              (annotations ?? []).flatMap((annotation) => [
                objectKey(annotation),
                ...(annotation.url ? [linkKey(annotation.url)] : []),
              ]),
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
export function ObjectAttachAction(props: { card: OwnedObjectAnnotation }) {
  const { url } = props.card;
  const target = useContext(ObjectAttachContext);
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: (id: string) =>
      post(
        attachObjectLinkResponseSchema,
        `/api/conversations/${encodeURIComponent(id)}/annotations`,
        { url },
      ),
    onSuccess: (_result, id) =>
      queryClient.invalidateQueries({
        queryKey: conversationDetailQueryKey(id),
      }),
  });
  if (!target || !url) return null;
  if (
    target.attached.has(linkKey(url)) ||
    target.attached.has(objectKey(props.card)) ||
    attach.isSuccess
  ) {
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
