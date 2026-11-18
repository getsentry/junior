import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useConversationDensity } from "../conversations/conversationDensity";
import { conversationPath } from "../conversations/conversationRoutes";
import { cn, dashboardSurfaceRadiusClass } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { itemNeedsViewer, type InboxBundle } from "./reviewItemFormat";
import { RowDismissButton, RowSnoozeButton } from "./RowSnoozeDismiss";

const QUIET_BUTTON_CLASS =
  "cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1 font-sans text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus";

/** How many rows a stack shows before the rest fold. */
export const STACK_FOLD = 4;

/**
 * The asks of one root Conversation in an Inbox section: a light border
 * around their rows, one row each, under the root's title. Past
 * `STACK_FOLD` rows, the rest fold under "+N more in this Conversation".
 * Folded rows stay in the list, hidden, so Next walks into them, and the
 * stack unfolds when one of them opens.
 */
export function InboxStack(props: {
  /** Its rows, one per key. */
  children: ReactNode;
  conversationId: string;
  expandedKey: string;
  keys: readonly string[];
  /** Dismiss all: every open ask of the stack that the viewer can act on. */
  onDismiss?(): void;
  /** Snooze all: every row of the stack. A snoozed stack has none. */
  onSnooze?(untilMs: number): void;
  onSnoozeMenu(open: boolean): void;
  snoozeMenuOpen: boolean;
  /** The stack's key in its section, as `todo:` and its Conversation. */
  stackKey: string;
  title: string;
}) {
  const openIndex = props.keys.indexOf(props.expandedKey);
  const [unfolded, setUnfolded] = useState(false);
  const [density] = useConversationDensity();
  const more = props.keys.length - STACK_FOLD;
  const folded = more > 0 && !unfolded && openIndex < STACK_FOLD;
  return (
    <li
      aria-label={props.title}
      className={cn(
        dashboardSurfaceRadiusClass,
        "grid min-w-0 list-none gap-1.5 border border-dashboard-border p-1.5",
      )}
      data-dock-key={`stack:${props.stackKey}`}
      // An open row keeps the dock still, as an open row does.
      data-expanded={openIndex >= 0 || undefined}
      data-inbox-stack={props.stackKey}
    >
      <div className="flex min-h-7 min-w-0 items-center gap-2 pr-1 pl-2.5">
        <Link
          className="mr-auto flex min-w-0 rounded-sm text-sm font-medium text-dashboard-text-muted no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
          to={conversationPath(props.conversationId)}
        >
          <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
            {props.title}
          </span>
        </Link>
        {/* The row bar's own buttons. Dismiss all is the main action, so it
            goes right-most. */}
        {props.onSnooze ? (
          <RowSnoozeButton
            look="quiet"
            label="Snooze all"
            onOpenChange={props.onSnoozeMenu}
            onSnooze={props.onSnooze}
            open={props.snoozeMenuOpen}
          />
        ) : null}
        {props.onDismiss ? (
          <RowDismissButton
            look="quiet"
            label="Dismiss all"
            onClick={props.onDismiss}
          />
        ) : null}
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
    </li>
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
  conversation: (id: string) => `conversation:${id}`,
  fyi: (id: string) => `fyi:${id}`,
  grabs: (id: string) => `grabs:${id}`,
  snoozed: (id: string) => id,
  todo: (id: string) => `todo:${id}`,
};

/**
 * In a Conversation section, a stack that shrinks to one item shows the
 * normal row of its Conversation, under the Conversation's key. While the
 * open row is that item's own, this returns the normal row's key and opens
 * that row, so the item stays open. To do, Up for grabs, and Snoozed keep
 * the item's own row, so their keys do not change.
 */
export function useLoneRowKey(
  conversationRows: readonly InboxBundle[],
  expandedKey: string,
  setExpandedKey: (key: string) => void,
): string | undefined {
  const keyOf = STACK_ROW_KEYS.conversation;
  const lone = conversationRows
    .filter((row) => row.items.length === 1)
    .map((row) => [keyOf(row.newest.id), keyOf(row.key)] as const)
    .find(([itemKey]) => itemKey === expandedKey)?.[1];
  useEffect(() => {
    if (lone) setExpandedKey(lone);
  }, [lone, setExpandedKey]);
  return lone;
}
