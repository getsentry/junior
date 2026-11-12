import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { conversationDisplayTitle } from "../format";
import type { Conversation } from "../types";
import { ContinueInSlackDialog } from "./ContinueInSlackDialog";
import { ConversationRowMenu } from "./ConversationRowMenu";
import { prefetchConversationDetail } from "./conversationPrefetch";
import { conversationPath, OPEN_EVENT_LOG_STATE } from "./conversationRoutes";
import { RenameConversationDialog } from "./RenameConversationDialog";
import { useConversationDelivery } from "./useConversationDelivery";
import { useConversationSubscription } from "./useConversationSubscription";
import { useRenameConversation } from "./useRenameConversation";

/**
 * Wrap a conversation row in the row menu, which opens on right-click or
 * long press. The row owns archive and pin, because its own buttons use
 * them too. The menu owns the other actions and their dialogs.
 */
export function ConversationRowContextMenu(
  props: Omit<ContextMenuPrimitive.Trigger.Props, "children"> & {
    archive: { pending: boolean; toggle(): void };
    children: ReactNode;
    conversation: Conversation;
    onActionError(conversation: Conversation, title: string): void;
    pin: { pending: boolean; set(pinned: boolean): void };
    /** The row is the open page. */
    selected?: boolean;
  },
) {
  const {
    archive,
    conversation,
    onActionError,
    pin,
    selected,
    ...triggerProps
  } = props;
  const rename = useRenameConversation(conversation.id, {
    onError: () => onActionError(conversation, "Could not rename"),
  });
  const subscription = useConversationSubscription(conversation.id, {
    onError: () => onActionError(conversation, "Could not update subscription"),
  });
  const delivery = useConversationDelivery(conversation.id, {
    onError: () =>
      onActionError(conversation, "Could not change Slack updates"),
  });
  const [renaming, setRenaming] = useState(false);
  const [continueInSlackOpen, setContinueInSlackOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <ContextMenu
      // The menu shows rows from the detail, so read it as a hover does.
      onOpenChange={(open) => {
        if (open) void prefetchConversationDetail(queryClient, conversation.id);
      }}
    >
      <ContextMenuTrigger {...triggerProps} />
      <ContextMenuContent>
        <ConversationRowMenu
          actions={{
            archive: archive.toggle,
            continueInSlack: () => setContinueInSlackOpen(true),
            delivery: (paused) => delivery.mutate(paused),
            // The page keeps its view in state, not in history. An open
            // page replaces its entry, so Back does not land on the same
            // page in the event log.
            eventLog: () =>
              navigate(conversationPath(conversation.id), {
                replace: selected,
                state: OPEN_EVENT_LOG_STATE,
              }),
            pin: pin.set,
            rename: () => setRenaming(true),
            subscription: (subscribed) => subscription.mutate(subscribed),
          }}
          conversation={conversation}
          conversationId={conversation.id}
          pending={{
            archive: archive.pending,
            delivery: delivery.isPending,
            pin: pin.pending,
            subscription: subscription.isPending,
          }}
        />
      </ContextMenuContent>
      {renaming ? (
        <RenameConversationDialog
          onClose={() => setRenaming(false)}
          onSave={(next) => rename.mutate(next)}
          title={conversationDisplayTitle(conversation)}
        />
      ) : null}
      {continueInSlackOpen ? (
        <ContinueInSlackDialog
          conversationId={conversation.id}
          onClose={() => setContinueInSlackOpen(false)}
        />
      ) : null}
    </ContextMenu>
  );
}
