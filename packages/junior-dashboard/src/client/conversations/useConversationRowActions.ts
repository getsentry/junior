import type { Conversation } from "../types";
import { useArchiveConversation } from "./conversationArchive";
import { usePinConversation } from "./usePinConversation";

/** The list callbacks that the actions of a conversation row report to. */
export type ConversationRowActionHandlers = {
  onActionError(conversation: Conversation, title: string): void;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  onPinned(conversation: Conversation): void;
  /** Runs before a row action that can move rows, so its result shows. */
  onRowAction(): void;
};

/**
 * Archive and pin for one conversation row. The row buttons and the row
 * menu use the same actions.
 */
export function useConversationRowActions(
  conversation: Conversation,
  handlers: ConversationRowActionHandlers,
) {
  const archive = useArchiveConversation(conversation.id, {
    // Read the attempted direction from the mutation call, not the (possibly
    // already optimistically updated) conversation prop, so a failed archive
    // never gets mislabeled as a failed restore.
    onError: () =>
      handlers.onArchiveError(
        conversation,
        archive.variables?.archived ?? true,
      ),
    onSuccess: (archived) => {
      if (archived) handlers.onArchived(conversation);
    },
  });
  const pin = usePinConversation(conversation.id, {
    onError: (pinned) =>
      handlers.onActionError(
        conversation,
        pinned ? "Could not pin" : "Could not unpin",
      ),
    onSuccess: () => handlers.onPinned(conversation),
  });
  return {
    archive: {
      pending: archive.isPending,
      toggle() {
        handlers.onRowAction();
        archive.mutate({
          archived: !conversation.archivedAt,
          lastSeenAt: conversation.lastSeenAt,
        });
      },
    },
    pin: {
      pending: pin.isPending,
      set(pinned: boolean) {
        handlers.onRowAction();
        pin.mutate(pinned);
      },
    },
  };
}
