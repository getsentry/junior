import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { ContextMenuContent } from "../components/ui/context-menu";
import { conversationDisplayTitle } from "../format";
import type { Conversation } from "../types";
import { ContinueInSlackDialog } from "./ContinueInSlackDialog";
import { useConversationActionToasts } from "./conversationActionToasts";
import { useArchiveConversation } from "./conversationArchive";
import { prefetchConversationDetail } from "./conversationPrefetch";
import { conversationPath, OPEN_EVENT_LOG_STATE } from "./conversationRoutes";
import { ConversationRowMenu } from "./ConversationRowMenu";
import { RenameConversationDialog } from "./RenameConversationDialog";
import { useConversationDelivery } from "./useConversationDelivery";
import { useConversationSubscription } from "./useConversationSubscription";
import { usePinConversation } from "./usePinConversation";
import { useRenameConversation } from "./useRenameConversation";

/**
 * The row actions of one Conversation in a list: pin, archive, rename,
 * subscription, Slack updates, and the event log. `menu` is the context
 * menu content with its dialogs; the row renders it inside its
 * `ContextMenu` and calls `onMenuOpenChange` from it. Failures show as
 * toasts. `onRowAction` runs before an action that can move rows, so a
 * held list shows the result at once.
 */
export function useConversationRowActions(
  conversation: Conversation,
  options: { onRowAction?(): void; selected: boolean },
) {
  const { clearActionError, showActionError, showArchiveError, showArchived } =
    useConversationActionToasts();
  const archive = useArchiveConversation(conversation.id, {
    // Read the attempted direction from the mutation call, not the (possibly
    // already optimistically updated) conversation, so a failed archive
    // never gets mislabeled as a failed restore.
    onError: () =>
      showArchiveError(conversation, archive.variables?.archived ?? true),
    onSuccess: (archived) => {
      if (archived) showArchived(conversation);
    },
  });
  const pin = usePinConversation(conversation.id, {
    onError: (pinning) =>
      showActionError(
        conversation,
        pinning ? "Could not pin" : "Could not unpin",
      ),
    onSuccess: () => clearActionError(conversation),
  });
  const rename = useRenameConversation(conversation.id, {
    onError: () => showActionError(conversation, "Could not rename"),
  });
  const subscription = useConversationSubscription(conversation.id, {
    onError: () =>
      showActionError(conversation, "Could not update subscription"),
  });
  const delivery = useConversationDelivery(conversation.id, {
    onError: () =>
      showActionError(conversation, "Could not change Slack updates"),
  });
  const [renaming, setRenaming] = useState(false);
  const [continueInSlackOpen, setContinueInSlackOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pinned = Boolean(conversation.pinnedAt);
  const archived = Boolean(conversation.archivedAt);
  const title = conversationDisplayTitle(conversation);
  const setPinned = (next: boolean) => {
    options.onRowAction?.();
    pin.mutate(next);
  };
  const toggleArchive = () => {
    options.onRowAction?.();
    archive.mutate({
      archived: !archived,
      lastSeenAt: conversation.lastSeenAt,
    });
  };
  return {
    archived,
    menu: (
      <>
        <ContextMenuContent>
          <ConversationRowMenu
            actions={{
              archive: toggleArchive,
              continueInSlack: () => setContinueInSlackOpen(true),
              delivery: (paused) => delivery.mutate(paused),
              // The page keeps its view in state, not in history. An open
              // page replaces its entry, so Back does not land on the same
              // page in the event log.
              eventLog: () =>
                navigate(conversationPath(conversation.id), {
                  replace: options.selected,
                  state: OPEN_EVENT_LOG_STATE,
                }),
              pin: setPinned,
              rename: () => setRenaming(true),
              subscription: (subscribed) => subscription.mutate(subscribed),
            }}
            conversation={conversation}
            conversationId={conversation.id}
            pending={{
              archive: archive.isPending,
              delivery: delivery.isPending,
              pin: pin.isPending,
              subscription: subscription.isPending,
            }}
          />
        </ContextMenuContent>
        {renaming ? (
          <RenameConversationDialog
            onClose={() => setRenaming(false)}
            onSave={(next) => rename.mutate(next)}
            title={title}
          />
        ) : null}
        {continueInSlackOpen ? (
          <ContinueInSlackDialog
            conversationId={conversation.id}
            onClose={() => setContinueInSlackOpen(false)}
          />
        ) : null}
      </>
    ),
    // The menu shows rows from the detail, so read it as a hover does.
    onMenuOpenChange: (open: boolean) => {
      if (open) void prefetchConversationDetail(queryClient, conversation.id);
    },
    pending: {
      archive: archive.isPending,
      pin: pin.isPending,
    },
    pinned,
    setPinned,
    title,
    toggleArchive,
  };
}
