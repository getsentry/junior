import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { ContextMenu, ContextMenuTrigger } from "../components/ui/context-menu";
import { useConversationDensity } from "../conversations/conversationDensity";
import { useInboxRowActions } from "../conversations/useInboxRowActions";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import type { Conversation } from "../types";
import { INBOX_STACK_CLASS } from "./inboxRowStyles";
import { onLinkOpen, openOnClick, useOpenPath } from "./rowClick";
import { itemNeedsViewer, type InboxBundle } from "./inboxItemFormat";
import { RowDismissButton } from "./RowDismissButton";
import { RowSnoozeButton } from "./RowSnoozeDismiss";
import type { EventSnooze } from "./snoozeChoices";

const QUIET_BUTTON_CLASS =
  "cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1 font-sans text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus";

function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** How many rows a stack shows before the rest fold. */
export const STACK_FOLD = 4;

/**
 * The asks of one root Conversation in an Inbox section: a light border
 * around their rows, one row each, under the root's title. Past
 * `STACK_FOLD` rows, the rest fold under "+N more in this Conversation".
 * Folded rows stay in the list, hidden, so Next walks into them, and the
 * stack unfolds when one of them opens. A click on the header's empty space
 * opens the root, as its title does, and a right-click anywhere on the
 * stack opens the root's Conversation menu.
 */
export function InboxStack(props: {
  /** Its rows, one per key. */
  children: ReactNode;
  /** The root, once loaded. It gives the stack its Conversation menu. */
  conversation?: Conversation;
  expandedKey: string;
  keys: readonly string[];
  /** How many asks Dismiss closes. */
  dismissCount?: number;
  /** Dismiss: every open ask of the stack that the viewer can act on. */
  onDismiss?(): void;
  /** Snooze on an Event of the subject that the stack's items share. */
  eventSnooze?: EventSnooze | undefined;
  /** Snooze: every row of the stack. A snoozed stack has none. */
  onSnooze?(untilMs: number): void;
  onSnoozeMenu(open: boolean): void;
  /** Runs when its header opens what it names. */
  onOpen?(): void;
  snoozeMenuOpen: boolean;
  /** Where its header opens: its root Conversation, or its owner. */
  path: string;
  /** The stack's key in its section, as `todo:` and its Conversation. */
  stackKey: string;
  title: string;
}) {
  const openIndex = props.keys.indexOf(props.expandedKey);
  const [unfolded, setUnfolded] = useState(false);
  const [density] = useConversationDensity();
  const more = props.keys.length - STACK_FOLD;
  const folded = more > 0 && !unfolded && openIndex < STACK_FOLD;
  const openPath = useOpenPath(props.path);
  const headerClick = openOnClick((event) => {
    props.onOpen?.();
    openPath(event);
  });
  const stack = {
    "aria-label": props.title,
    className: INBOX_STACK_CLASS,
    "data-dock-key": `stack:${props.stackKey}`,
    // An open row keeps the dock still, as an open row does.
    "data-expanded": openIndex >= 0 || undefined,
    "data-inbox-stack": props.stackKey,
  };
  const body = (
    <>
      {/* The title link is the header's keyboard target. */}
      <div
        className="flex min-h-7 min-w-0 cursor-pointer items-center gap-2 pr-1 pl-2.5"
        data-inbox-stack-head=""
        {...headerClick}
      >
        <Link
          className="mr-auto flex min-w-0 rounded-sm text-sm font-medium text-dashboard-text-muted no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
          {...onLinkOpen(props.onOpen)}
          to={props.path}
        >
          <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
            {props.title}
          </span>
        </Link>
        {/* The stack's own buttons: Dismiss, then Snooze, in the order of
            a row's actions. The count shows once, right-most, so a scan
            reads it. The names say what each button covers. */}
        {props.onDismiss ? (
          <RowDismissButton
            look="quiet"
            name={`Dismiss ${itemCount(props.dismissCount ?? props.keys.length)} in this stack`}
            onClick={props.onDismiss}
          />
        ) : null}
        {props.onSnooze ? (
          <RowSnoozeButton
            eventSnooze={props.eventSnooze}
            look="quiet"
            name={`Snooze ${itemCount(props.keys.length)} in this stack`}
            onOpenChange={props.onSnoozeMenu}
            onSnooze={props.onSnooze}
            open={props.snoozeMenuOpen}
          />
        ) : null}
        <span className="px-1 text-xs text-dashboard-text-muted tabular-nums">
          {props.keys.length}
          <span className="sr-only"> items</span>
        </span>
      </div>
      <ul
        className={cn(
          // An open row stays inside the border.
          "m-0 grid p-0 [&>li]:mx-0 [&>li[data-expanded]]:my-2",
          density === "comfortable" ? "gap-2" : "gap-1.5",
          // `STACK_FOLD` rows show; the rest hide.
          folded && "[&>li:nth-child(n+5)]:hidden",
        )}
        data-dock-list=""
      >
        {props.children}
      </ul>
      {folded ? (
        <button
          className={cn(QUIET_BUTTON_CLASS, "justify-self-start")}
          onClick={() => setUnfolded(true)}
          type="button"
        >
          +{more} more in this Conversation
        </button>
      ) : null}
    </>
  );
  return props.conversation ? (
    <StackMenu conversation={props.conversation} stack={stack}>
      {body}
    </StackMenu>
  ) : (
    <li {...stack}>{body}</li>
  );
}

/** The stack, with its root's Conversation menu on a right-click. */
function StackMenu(props: {
  children: ReactNode;
  conversation: Conversation;
  stack: { className: string };
}) {
  const actions = useInboxRowActions(props.conversation, { selected: false });
  return (
    <ContextMenu onOpenChange={actions.onMenuOpenChange}>
      <ContextMenuTrigger
        {...props.stack}
        // The cards keep their text selectable.
        className={cn(props.stack.className, "select-text")}
        render={<li />}
      >
        {props.children}
      </ContextMenuTrigger>
      {actions.menu}
      {actions.dialogs}
    </ContextMenu>
  );
}

/**
 * The rows of a stack: each item with its row key, and the rows that leave
 * with it. In To do, the stack leaves with its last ask for the viewer, and
 * its FYIs go to their own section, so none of its rows opens next.
 */
export function stackRows(
  bundle: InboxBundle,
  keyOf: (id: string) => string,
  todo = false,
) {
  const keys = bundle.items.map((item) => keyOf(item.id));
  return bundle.items.map((item, index) => ({
    item,
    key: keys[index] ?? item.id,
    passing:
      todo &&
      !bundle.items.some((other) => other !== item && itemNeedsViewer(other))
        ? new Set(keys)
        : undefined,
  }));
}

/** The row key of an item or a Conversation in each section with stacks. */
export const STACK_ROW_KEYS = {
  fyi: (id: string) => `fyi:${id}`,
  grabs: (id: string) => `grabs:${id}`,
  snoozed: (id: string) => id,
  todo: (id: string) => `todo:${id}`,
};
