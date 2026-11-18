import { Pin } from "lucide-react";
import { useCallback, useId } from "react";
import { Link } from "react-router";

import { Spinner } from "../components/ui/spinner";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
} from "../conversations/PinnedConversationOrder";
import { useReorderPinnedConversations } from "../conversations/useReorderPinnedConversations";
import { cn, dashboardCountClass } from "../styles";
import type { Conversation } from "../types";
import { useInboxData } from "./inboxData";
import { useInboxReturnHere, useInFlightExpanded } from "./inboxListState";
import { paneEntryClass, PaneDestinations } from "./PaneDestinations";

function InFlightRow(props: {
  conversation: Conversation;
  phone?: boolean;
  selected: boolean;
}) {
  const { conversation } = props;
  const drag = usePinnedRowDrag(conversation.id);
  return (
    <li
      className={cn("list-none", drag?.dragging && "opacity-40")}
      onKeyDown={drag?.onKeyDown}
      ref={drag?.setNodeRef}
      {...drag?.listeners}
    >
      <Link
        aria-current={props.selected ? "page" : undefined}
        aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        className={paneEntryClass(props.selected, props.phone)}
        draggable={drag ? false : undefined}
        to={conversationPath(conversation.id)}
      >
        {conversation.status === "active" ? (
          <Spinner
            aria-label="Running"
            className="size-3 justify-self-center text-emerald-500 dark:text-emerald-300"
          />
        ) : (
          <Pin
            aria-label="Pinned"
            className="size-3.5 justify-self-center text-dashboard-text-muted"
            role="img"
          />
        )}
        <span className="truncate text-dashboard-text">
          {conversation.displayTitle}
        </span>
      </Link>
    </li>
  );
}

/**
 * The pane, like Google Inbox: no list of Conversations, only the
 * destinations that open a list in the main area, then the Conversations
 * in flight, running or pinned, each one click away. Pins drag into a new
 * order here. Every page with destinations shows it.
 */
export function InboxNav(props: {
  /** On a phone the entries are a page, and each opens its list page. */
  phone?: boolean;
  selectedConversationId?: string;
}) {
  const data = useInboxData();
  // On a phone the entries are a screen of their own, so Back from what
  // they open returns here.
  useInboxReturnHere(props.phone ? "/" : undefined);
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
      {data.inFlight.length > 0 ? (
        <>
          <h2 className="m-0 flex items-baseline justify-between px-3 pt-5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
            In flight
            <span className={dashboardCountClass}>{data.inFlight.length}</span>
          </h2>
          {/* Every pin shows, so a drop can place them all. Running pins
              show first, so a drop moves the pin within the stored order,
              and the other pins keep theirs. */}
          <PinnedConversationOrder
            conversations={data.pinned}
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
