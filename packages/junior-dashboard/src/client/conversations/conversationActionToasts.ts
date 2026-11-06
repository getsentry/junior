import { useCallback, useMemo } from "react";
import { MutationObserver, useQueryClient } from "@tanstack/react-query";

import { useToastManager } from "../components/ui/toast";
import { conversationDisplayTitle } from "../format";
import type { Conversation } from "../types";
import { archiveConversationMutationOptions } from "./conversationArchive";

// One undo toast at a time: a new archive replaces it and restarts its timer.
const ARCHIVED_TOAST_ID = "conversation-archived";
const ARCHIVE_UNDO_TIMEOUT_MS = 6_000;

function actionErrorToastId(conversationId: string) {
  return `conversation-action-error:${conversationId}`;
}

/**
 * Report conversation row actions through the dashboard toaster. The undo
 * action restores through the query client, so it keeps working after the
 * list that archived the conversation unmounts.
 */
export function useConversationActionToasts() {
  const { add, close, update } = useToastManager();
  const queryClient = useQueryClient();

  const showActionError = useCallback(
    (conversation: Conversation, title: string) => {
      add({
        description: conversationDisplayTitle(conversation),
        id: actionErrorToastId(conversation.id),
        priority: "high",
        title,
        type: "error",
      });
    },
    [add],
  );

  const showArchiveError = useCallback(
    (conversation: Conversation, wasArchiving: boolean) => {
      showActionError(
        conversation,
        wasArchiving ? "Could not archive" : "Could not restore",
      );
    },
    [showActionError],
  );

  // A later success on the same conversation replaces its error.
  const clearActionError = useCallback(
    (conversation: Conversation) => {
      close(actionErrorToastId(conversation.id));
    },
    [close],
  );

  const showArchived = useCallback(
    (conversation: Conversation) => {
      clearActionError(conversation);
      const title = conversationDisplayTitle(conversation);
      const undoLabel = `Undo archive for ${title}`;
      const restore = () => {
        update(ARCHIVED_TOAST_ID, {
          actionProps: {
            "aria-label": undoLabel,
            children: "Restoring…",
            disabled: true,
          },
          type: "loading",
        });
        new MutationObserver(
          queryClient,
          archiveConversationMutationOptions(queryClient, conversation.id),
        )
          .mutate({ archived: false, lastSeenAt: conversation.lastSeenAt })
          .then(
            () => close(ARCHIVED_TOAST_ID),
            () => {
              close(ARCHIVED_TOAST_ID);
              showActionError(conversation, "Could not restore");
            },
          );
      };
      add({
        actionProps: {
          "aria-label": undoLabel,
          children: "Undo",
          onClick: restore,
        },
        description: title,
        id: ARCHIVED_TOAST_ID,
        timeout: ARCHIVE_UNDO_TIMEOUT_MS,
        title: "Conversation archived",
        type: "success",
      });
    },
    [add, clearActionError, close, queryClient, showActionError, update],
  );

  return useMemo(
    () => ({
      clearActionError,
      showActionError,
      showArchiveError,
      showArchived,
    }),
    [clearActionError, showActionError, showArchiveError, showArchived],
  );
}
