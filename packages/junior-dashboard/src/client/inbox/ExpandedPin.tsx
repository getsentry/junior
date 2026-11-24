import { Pin, PinOff } from "lucide-react";

import { Button } from "../components/ui/button";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { usePinConversation } from "../conversations/usePinConversation";
import type { Conversation } from "../types";
import { ButtonLabel, LOOK_CLASSES, type ButtonLook } from "./RowDismissButton";

/** Pin the Conversation from the open row. There is one pin: its own. */
export function ExpandedPin(props: {
  conversation: Conversation;
  look?: ButtonLook | undefined;
}) {
  const { clearActionError, showActionError } = useConversationActionToasts();
  const pin = usePinConversation(props.conversation.id, {
    onError: (pinning) =>
      showActionError(
        props.conversation,
        pinning ? "Could not pin" : "Could not unpin",
        () => pin.mutate(pinning),
      ),
    onSuccess: () => clearActionError(props.conversation),
  });
  const pinned = Boolean(props.conversation.pinnedAt);
  return (
    <Button
      aria-pressed={pinned}
      className={props.look && LOOK_CLASSES[props.look]}
      disabled={pin.isPending}
      onClick={() => pin.mutate(!pinned)}
      variant="ghost"
    >
      {pinned ? (
        <PinOff aria-hidden="true" size={15} />
      ) : (
        <Pin aria-hidden="true" size={15} />
      )}
      <ButtonLabel look={props.look}>{pinned ? "Unpin" : "Pin"}</ButtonLabel>
    </Button>
  );
}
