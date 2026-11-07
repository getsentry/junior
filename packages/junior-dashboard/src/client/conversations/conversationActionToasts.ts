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
      const undoAction = {
        "aria-label": undoLabel,
        children: "Undo",
        onClick: restore,
      };
      // The loading type stops the auto-dismiss timer while the request runs.
      function restore() {
        update(ARCHIVED_TOAST_ID, {
          actionProps: {
            ...undoAction,
            children: "Restoring…",
            disabled: true,
          },
          type: "loading",
        });
        new MutationObserver(
          queryClient,
          archiveConversationMutationOptions(queryClient, conversation.id),
        )
          .mutate({
            // Undo restores everything that the child archive archived.
            applyToChildren: conversation.kind !== "root",
            archived: false,
            lastSeenAt: conversation.lastSeenAt,
          })
          .then(() => close(ARCHIVED_TOAST_ID), restoreFailed);
      }
      // Keep Undo available for a retry, unless a newer archive took the toast.
      function restoreFailed() {
        let kept = false;
        update(ARCHIVED_TOAST_ID, (toast) => {
          if (toast.data?.conversationId !== conversation.id) return {};
          kept = true;
          return {
            actionProps: undoAction,
            timeout: ARCHIVE_UNDO_TIMEOUT_MS,
            title: "Could not restore",
            type: "error",
          };
        });
        if (!kept) showActionError(conversation, "Could not restore");
      }
      add({
        actionProps: undoAction,
        data: { conversationId: conversation.id },
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
