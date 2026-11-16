import { useRef, useState, type ReactNode } from "react";
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
import {
  ConversationRowMenu,
  type ConversationRowMenuProps,
} from "./ConversationRowMenu";
import { ConversationRowSheet } from "./ConversationRowSheet";
import { prefetchConversationDetail } from "./conversationPrefetch";
import { conversationPath, OPEN_EVENT_LOG_STATE } from "./conversationRoutes";
import { RenameConversationDialog } from "./RenameConversationDialog";
import { useConversationDelivery } from "./useConversationDelivery";
import { useConversationSubscription } from "./useConversationSubscription";
import { useRenameConversation } from "./useRenameConversation";

/**
 * Wrap a conversation row in the row menu. A right-click opens it at the
 * pointer, and a long press on a touch screen opens it as a bottom sheet. The
 * row owns archive and pin, because its own buttons use them too. The menu
 * owns the other actions and their dialogs.
 */
export function ConversationRowContextMenu(
  props: Omit<ContextMenuPrimitive.Trigger.Props, "children"> & {
    archive: { pending: boolean; toggle(): void };
    children: ReactNode;
    conversation: Conversation;
    onActionError(conversation: Conversation, title: string): void;
    pin: { pending: boolean; set(pinned: boolean): void };
    /** The row is the open page. */
    selected?: boolean | undefined;
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
  const [sheetOpen, setSheetOpen] = useState(false);
  // Set from the long press until the finger lifts.
  const touchOpenedRef = useRef(false);
  const [pressing, setPressing] = useState(false);
  const pressStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const endPress = () => {
    pressStartRef.current = undefined;
    setPressing(false);
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const menu: ConversationRowMenuProps = {
    actions: {
      archive: archive.toggle,
      continueInSlack: () => setContinueInSlackOpen(true),
      delivery: (paused) => delivery.mutate(paused),
      // The page keeps its view in state, not in history. An open
      // page replaces its entry, so Back does not land on the same
      // page in the event log.
      eventLog: () =>
        void navigate(conversationPath(conversation.id), {
          replace: selected,
          state: OPEN_EVENT_LOG_STATE,
        }),
      pin: pin.set,
      rename: () => setRenaming(true),
      subscription: (subscribed) => subscription.mutate(subscribed),
    },
    conversation,
    conversationId: conversation.id,
    pending: {
      archive: archive.pending,
      delivery: delivery.isPending,
      pin: pin.pending,
      subscription: subscription.isPending,
    },
  };
  return (
    <ContextMenu
      onOpenChange={(open, details) => {
        if (!open) return;
        // The menu shows rows from the detail, so read it as a hover does.
        void prefetchConversationDetail(queryClient, conversation.id);
        if (!isTouchEvent(details.event)) return;
        details.cancel();
        touchOpenedRef.current = true;
        endPress();
        setSheetOpen(true);
      }}
    >
      <ContextMenuTrigger
        {...triggerProps}
        // The row can show a touch press while the long press runs.
        data-pressing={pressing ? "" : undefined}
        onTouchCancel={(event) => {
          triggerProps.onTouchCancel?.(event);
          touchOpenedRef.current = false;
          endPress();
        }}
        onTouchEnd={(event) => {
          triggerProps.onTouchEnd?.(event);
          // The sheet is open under the finger. Stop the click that the
          // lift would send to the row link or the sheet backdrop.
          if (touchOpenedRef.current) event.preventDefault();
          touchOpenedRef.current = false;
          endPress();
        }}
        onTouchMove={(event) => {
          triggerProps.onTouchMove?.(event);
          const start = pressStartRef.current;
          const touch = event.touches[0];
          if (!start || !touch) return;
          const moved = Math.max(
            Math.abs(touch.clientX - start.x),
            Math.abs(touch.clientY - start.y),
          );
          if (moved > LONG_PRESS_MOVE_PX) endPress();
        }}
        onTouchStart={(event) => {
          triggerProps.onTouchStart?.(event);
          const touch = event.touches[0];
          if (event.touches.length !== 1 || !touch) return endPress();
          pressStartRef.current = { x: touch.clientX, y: touch.clientY };
          setPressing(true);
        }}
      />
      <ContextMenuContent>
        <ConversationRowMenu {...menu} />
      </ContextMenuContent>
      {sheetOpen ? (
        <ConversationRowSheet
          {...menu}
          onClose={() => setSheetOpen(false)}
          title={conversationDisplayTitle(conversation)}
        />
      ) : null}
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

// A move past this ends the press, as it ends the Base UI long press. Touch
// coordinates are CSS px.
const LONG_PRESS_MOVE_PX = 10;

// A long press sends a touch event. Android can also send a contextmenu
// pointer event from the touch.
function isTouchEvent(event: Event | undefined) {
  if (!event) return false;
  if (event.type.startsWith("touch")) return true;
  return "pointerType" in event && event.pointerType === "touch";
}
