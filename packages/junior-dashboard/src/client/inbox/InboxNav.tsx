import { Ellipsis } from "lucide-react";
import { useCallback, useId } from "react";
import { Link } from "react-router";

import {
  browserMenuOnLinks,
  ContextMenu,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  StatusIndicator,
  statusIndicatorState,
} from "../conversations/StatusIndicator";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
} from "../conversations/PinnedConversationOrder";
import {
  ROW_ACTION_BUTTON_CLASS,
  ROW_ACTIONS_REVEAL_CLASS,
} from "../conversations/sidebarRowActions";
import { useInboxRowActions } from "../conversations/useInboxRowActions";
import { useReorderPinnedConversations } from "../conversations/useReorderPinnedConversations";
import { cn, dashboardCountClass } from "../styles";
import type { Conversation } from "../types";
import { useInboxData } from "./inboxData";
import { useInboxReturnHere, useInFlightExpanded } from "./inboxListState";
import { inboxViewPath } from "./inboxModel";
import { paneEntryClass, PaneDestinations } from "./PaneDestinations";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { SpacesNav } from "../spaces/SpacesNav";

function InFlightRow(props: {
  conversation: Conversation;
  phone?: boolean;
  selected: boolean;
}) {
  const { conversation } = props;
  const drag = usePinnedRowDrag(conversation.id);
  const actions = useInboxRowActions(conversation, {
    move: drag?.move,
    selected: props.selected,
  });
  return (
    <ContextMenu onOpenChange={actions.onMenuOpenChange}>
      <ContextMenuTrigger
        {...browserMenuOnLinks}
        className={cn(
          "group relative list-none",
          drag?.dragging && "opacity-40",
        )}
        onKeyDown={drag?.onKeyDown}
        ref={drag?.setNodeRef}
        render={<li />}
        {...drag?.listeners}
      >
        <Link
          aria-current={props.selected ? "page" : undefined}
          aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          className={cn(
            // The state sits on the right, as on a Space row, so the title
            // takes the icon column.
            paneEntryClass(
              props.selected ? "page" : undefined,
              props.phone,
              false,
            ),
            // Phones always show the `⋯`, so the title stops before it.
            "max-sm:pr-10",
            // The row shows which Conversation its open menu acts on.
            !props.selected &&
              "group-data-popup-open:bg-dashboard-fill-hover group-has-data-popup-open:bg-dashboard-fill-hover",
            // A long press opens the row menu, not the iOS link callout.
            "[-webkit-touch-callout:none]",
          )}
          data-row-menu=""
          draggable={drag ? false : undefined}
          to={conversationPath(conversation.id)}
        >
          <span
            className={cn(fadeOverflowClass, "text-dashboard-text")}
            ref={fadeWhenOverflowing}
          >
            {conversation.displayTitle}
          </span>
          {/* The `⋯` takes the state's place while it shows. Phones show
              both. */}
          <StatusIndicator
            className="sm:group-focus-within:invisible sm:group-hover:invisible sm:group-has-data-popup-open:invisible"
            state={statusIndicatorState(conversation)}
          />
        </Link>
        <DropdownMenu modal={false} onOpenChange={actions.onMenuOpenChange}>
          <DropdownMenuTrigger
            render={
              <button
                aria-label={`Open menu for ${actions.title}`}
                className={cn(
                  ROW_ACTION_BUTTON_CLASS,
                  ROW_ACTIONS_REVEAL_CLASS,
                  "absolute top-1/2 right-1 -translate-y-1/2 border-0 bg-transparent p-0",
                  // The `⋯` stays while its menu is open.
                  "sm:data-popup-open:pointer-events-auto sm:data-popup-open:opacity-100",
                )}
                type="button"
              >
                <Ellipsis aria-hidden="true" size={16} />
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            {actions.rows}
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      {actions.menu}
      {actions.dialogs}
    </ContextMenu>
  );
}

/**
 * The pane, like Google Inbox: no list of Conversations, only the
 * destinations that open a list in the main area, then the viewer's
 * Spaces, then the Conversations in flight, running or pinned, each one
 * click away. Pins drag into a new order here. Every page with destinations
 * shows it.
 */
export function InboxNav(props: {
  /** On a phone the entries are a page, and each opens its list page. */
  phone?: boolean;
  selectedConversationId?: string;
  /** The Space of the selected Conversation. A child is in its root's. */
  selectedSpaceId?: string;
}) {
  const data = useInboxData();
  // On a phone the entries are a screen of their own, so Back from what
  // they open returns here.
  useInboxReturnHere(props.phone ? inboxViewPath("inbox") : undefined);
  const reorderPins = useReorderPinnedConversations();
  const { showActionError } = useConversationActionToasts();
  const onReorderError = useCallback(
    (conversation: Conversation) =>
      showActionError(conversation, "Could not reorder"),
    [showActionError],
  );
  const [expanded, setExpanded] = useInFlightExpanded();
  const inFlightId = useId();
  const hidden = data.inFlight.length > data.inFlightCollapsed.length;
  const rows = expanded ? data.inFlight : data.inFlightCollapsed;
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "thin-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain bg-dashboard-surface-panel pb-6",
        props.phone
          ? "px-2 pt-2"
          : "border-r border-dashboard-border px-3 pt-2",
      )}
    >
      <PaneDestinations phone={props.phone} />
      <SpacesNav
        conversationSpaceId={props.selectedSpaceId}
        phone={props.phone}
        signedIn={data.signedIn}
      />
      {data.inFlight.length > 0 ? (
        <>
          <h2 className="m-0 flex items-baseline justify-between px-3 pt-5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
            In flight
            <span className={dashboardCountClass}>{data.inFlight.length}</span>
          </h2>
          {/* Every pin here shows, in the stored order. The API places
              the pins that a drop leaves out after the ones it lists. */}
          <PinnedConversationOrder
            conversations={data.inFlightPinned}
            onError={onReorderError}
            reorder={reorderPins}
          >
            <ul
              aria-label="In flight"
              className="m-0 grid gap-0.5 p-0"
              id={inFlightId}
            >
              {rows.map((conversation) => (
                <InFlightRow
                  conversation={conversation}
                  key={conversation.id}
                  phone={props.phone}
                  selected={props.selectedConversationId === conversation.id}
                />
              ))}
            </ul>
          </PinnedConversationOrder>
          {hidden ? (
            <button
              aria-controls={inFlightId}
              aria-expanded={expanded}
              className="mt-1 ml-10 cursor-pointer border-0 bg-transparent p-0 font-sans text-xs text-dashboard-text-muted hover:text-dashboard-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              {expanded ? "Show fewer" : "Show all"}
            </button>
          ) : null}
        </>
      ) : null}
    </nav>
  );
}
