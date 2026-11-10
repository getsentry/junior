import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  type LucideIcon,
} from "lucide-react";

type MenuAction = { disabled: boolean; onClick(): void };

/** One conversation action. Each menu renders it with its own primitive. */
type ConversationMenuItem = MenuAction & {
  icon: LucideIcon;
  key: string;
  label: string;
};

/**
 * List the actions that the conversation `⋯` menu and the sidebar row menu
 * share, in display order. Both menus render this list, so labels, icons, and
 * order cannot drift apart. Each caller owns its enabled rules.
 */
export function conversationMenuItems(actions: {
  archive: MenuAction & { archived: boolean; pending: boolean };
  pin: MenuAction & { pinned: boolean };
  read: MenuAction & { unread: boolean };
  rename: MenuAction;
  /** Feed rows carry no subscription state, so only the page passes it. */
  subscription?: MenuAction & { subscribed: boolean };
}): ConversationMenuItem[] {
  const { archive, pin, read, rename, subscription } = actions;
  const items: ConversationMenuItem[] = [
    {
      disabled: read.disabled,
      icon: read.unread ? MailOpen : Mail,
      key: "read",
      label: read.unread ? "Mark as read" : "Mark as unread",
      onClick: read.onClick,
    },
  ];
  // A pin restores an archived conversation for everyone, so archived
  // conversations restore first.
  if (!archive.archived) {
    items.push({
      disabled: pin.disabled,
      icon: pin.pinned ? PinOff : Pin,
      key: "pin",
      label: pin.pinned ? "Unpin" : "Pin",
      onClick: pin.onClick,
    });
  }
  items.push({
    disabled: rename.disabled,
    icon: Pencil,
    key: "rename",
    label: "Rename",
    onClick: rename.onClick,
  });
  if (subscription) {
    items.push({
      disabled: subscription.disabled,
      icon: subscription.subscribed ? BellOff : Bell,
      key: "subscription",
      label: subscription.subscribed ? "Unsubscribe" : "Subscribe",
      onClick: subscription.onClick,
    });
  }
  items.push({
    disabled: archive.disabled,
    icon: archive.archived ? ArchiveRestore : Archive,
    key: "archive",
    label: archive.pending
      ? "Saving archive state"
      : archive.archived
        ? "Restore"
        : "Archive",
    onClick: archive.onClick,
  });
  return items;
}
