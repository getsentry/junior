import type { ComponentType } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  MessageSquareShare,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  ScrollText,
  Unlink,
} from "lucide-react";

import { useCopyText } from "../components/CopyButton";
import { visualStatusForConversation } from "../format";
import type { Conversation } from "../types";
import { SlackMark } from "./SlackMark";
import { useShareConversationLink } from "./useShareConversationLink";

/** One conversation menu row. Each menu renders it with its own primitive. */
export type ConversationMenuItem = {
  disabled?: boolean;
  /** Status text for assistive technology, such as a share result. */
  feedback?: string;
  /** Opens in a new tab. */
  href?: string;
  icon: ComponentType<{ "aria-hidden"?: "true"; className?: string }>;
  key: string;
  label: string;
  onClick?(): void;
  /** Only the label shows the result, so the menu stays open. */
  stayOpen?: boolean;
  /** The label flips to the opposite action after a click. */
  toggle?: boolean;
};

/** What a conversation menu acts on, and what each row does. */
export type ConversationMenu = {
  /** Each toggle gets the state to set. */
  actions: {
    archive(): void;
    continueInSlack(): void;
    delivery(paused: boolean): void;
    eventLog(): void;
    pin(pinned: boolean): void;
    rename(): void;
    subscription(subscribed: boolean): void;
  };
  /** Unset until the Conversation loads. */
  conversation: Conversation | undefined;
  conversationId: string;
  /** Unset until the detail loads. Rows that need it show after that. */
  detail:
    | Pick<
        ConversationDetailReport,
        | "canContinueInSlack"
        | "deliveryPaused"
        | "isParticipant"
        | "sentryConversationUrl"
        | "status"
        | "subscribed"
      >
    | undefined;
  /** The page shows its event log, so the row goes back to the conversation. */
  eventLogOpen?: boolean;
  getMarkdown?: () => Promise<string>;
  pending: {
    archive: boolean;
    delivery: boolean;
    pin: boolean;
    subscription: boolean;
  };
};

/**
 * List the rows of the conversation `⋯` menu and the sidebar row menu, in
 * groups that the menus divide with a separator. Both menus render this
 * list, so their rows, order, labels, icons, and enabled rules stay the same.
 */
export function useConversationMenuItems(
  menu: ConversationMenu,
): ConversationMenuItem[][] {
  const share = useShareConversationLink(menu.conversationId);
  const copy = useCopyText({
    copyingLabel: "Preparing Markdown",
    getText: menu.getMarkdown,
    label: "Copy as Markdown",
  });
  const { actions, conversation, detail, pending } = menu;
  const archived = Boolean(conversation?.archivedAt);
  const pinned = Boolean(conversation?.pinnedAt);
  // The API takes these changes only from participants.
  const participant = Boolean(
    conversation && (detail?.isParticipant ?? conversation.isParticipant),
  );
  const live = detail
    ? detail.status === "active"
    : conversation && visualStatusForConversation(conversation) === "active";

  const conversationItems: ConversationMenuItem[] = [
    {
      disabled: share.disabled,
      feedback: share.feedback,
      icon: share.icon,
      key: "share",
      label: share.label,
      onClick: () => void share.share(),
      stayOpen: true,
    },
    {
      disabled: copy.disabled,
      icon: copy.icon,
      key: "copy-markdown",
      label: copy.label,
      onClick: () => void copy.copy(),
      stayOpen: true,
    },
  ];
  if (detail?.canContinueInSlack) {
    conversationItems.push({
      // The API refuses while a Turn runs.
      disabled: Boolean(live),
      icon: SlackIcon,
      key: "continue-in-slack",
      label: "Continue in Slack",
      onClick: actions.continueInSlack,
    });
  }
  // Only a viewer who can detach the conversation gets `deliveryPaused`.
  if (detail?.deliveryPaused !== undefined) {
    conversationItems.push({
      disabled: pending.delivery,
      icon: detail.deliveryPaused ? MessageSquareShare : Unlink,
      key: "delivery",
      label: detail.deliveryPaused ? "Reattach to Slack" : "Detach from Slack",
      onClick: () => actions.delivery(!detail.deliveryPaused),
      toggle: true,
    });
  }
  conversationItems.push({
    icon: menu.eventLogOpen ? MessagesSquare : ScrollText,
    key: "event-log",
    label: menu.eventLogOpen ? "Back to conversation" : "Open event log",
    onClick: actions.eventLog,
  });
  if (detail?.sentryConversationUrl) {
    conversationItems.push({
      href: detail.sentryConversationUrl,
      icon: SentryGlyph,
      key: "sentry",
      label: "Open in Sentry",
    });
  }

  const viewerItems: ConversationMenuItem[] = [];
  // A pin restores an archived conversation for everyone, so archived
  // conversations restore first.
  if (!archived) {
    viewerItems.push({
      // Threads and Tasks use their root's pin.
      disabled:
        !participant ||
        Boolean(conversation?.parentConversationId) ||
        pending.pin,
      icon: pinned ? PinOff : Pin,
      key: "pin",
      label: pinned ? "Unpin" : "Pin",
      onClick: () => actions.pin(!pinned),
      toggle: true,
    });
  }
  viewerItems.push(
    {
      disabled: !participant,
      icon: Pencil,
      key: "rename",
      label: "Rename",
      onClick: actions.rename,
    },
    {
      // Only participants have a subscription. A child uses its root's.
      disabled: detail?.subscribed === undefined || pending.subscription,
      icon: detail?.subscribed ? BellOff : Bell,
      key: "subscription",
      label: detail?.subscribed ? "Unsubscribe" : "Subscribe",
      onClick: () => actions.subscription(!detail?.subscribed),
      toggle: true,
    },
    {
      disabled: !participant || pending.archive,
      icon: archived ? ArchiveRestore : Archive,
      key: "archive",
      label: pending.archive
        ? "Saving archive state"
        : archived
          ? "Restore"
          : "Archive",
      onClick: actions.archive,
    },
  );
  return [conversationItems, viewerItems];
}

function SlackIcon(props: { className?: string }) {
  return (
    <span aria-hidden="true" className="inline-flex">
      <SlackMark className={props.className} />
    </span>
  );
}

/** Draw the Sentry glyph in the current text color. */
function SentryGlyph(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
    </svg>
  );
}
