import { MessagesSquare, Zap } from "lucide-react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { buttonVariants } from "../components/ui/button";
import { conversationPath } from "../conversations/conversationRoutes";
import { cn } from "../styles";
import { itemConversationId } from "./inboxItemFormat";
import { useInboxItemTurnMessage } from "./InboxItemTurnMessage";
import { LOOK_CLASSES, type ButtonLook } from "./RowDismissButton";
import { onLinkOpen } from "./rowClick";

/**
 * What the row's Open action opens: an item row's owner, such as its
 * Automation, or the row's Conversation.
 */
export type RowOpenTarget = {
  automation: boolean;
  label: string;
  onClick?(): void;
  path: string;
};

/**
 * The open row's link to its owner. It names where it goes, and its icon is
 * the one the Conversations or Automations page uses, so it does not read
 * as a link that leaves the dashboard, like a card's main action.
 */
export function RowOwnerLink(props: {
  look?: ButtonLook | undefined;
  /** The link is the card's main action. */
  main?: boolean;
  open: RowOpenTarget;
  /** Where it opens in place of `open.path`. */
  path?: string | undefined;
}) {
  const OwnerIcon = props.open.automation ? Zap : MessagesSquare;
  return (
    <Link
      aria-label={props.open.label}
      className={cn(
        buttonVariants({ variant: props.main ? "default" : "ghost" }),
        props.look && LOOK_CLASSES[props.look],
      )}
      {...onLinkOpen(props.open.onClick)}
      to={props.path ?? props.open.path}
    >
      <OwnerIcon aria-hidden="true" size={15} />
      {props.open.automation ? "Automation" : "Conversation"}
    </Link>
  );
}

/**
 * A reply notice's main action: its Conversation at the reply, once the
 * card's read of the notice's Turn finds the reply. Until then, or when the
 * read fails, it opens what the row opens.
 */
export function ReplyNoticeLink(props: {
  item: InboxItemPayload;
  open: RowOpenTarget;
}) {
  const reply = useInboxItemTurnMessage(props.item);
  const conversationId = itemConversationId(props.item);
  return (
    <RowOwnerLink
      // As tall as a code change card's main action on a phone.
      look="tall"
      main
      open={props.open}
      path={
        reply && conversationId
          ? conversationPath(conversationId, { messageId: reply.messageId })
          : undefined
      }
    />
  );
}
