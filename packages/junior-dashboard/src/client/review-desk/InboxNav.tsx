import {
  CircleCheck,
  Clock3,
  GitPullRequest,
  Inbox,
  MessageCircleQuestion,
  MessagesSquare,
  Pin,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useCallback } from "react";
import { Link, useLocation, useSearchParams } from "react-router";

import { Spinner } from "../components/ui/spinner";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
} from "../conversations/PinnedConversationOrder";
import { useReorderPinnedConversations } from "../conversations/useReorderPinnedConversations";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { useInboxData } from "./inboxData";
import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  parseInboxView,
  type InboxView,
} from "./inboxModel";

const ICONS: Record<InboxView, LucideIcon> = {
  automations: Workflow,
  conversations: MessagesSquare,
  decisions: MessageCircleQuestion,
  done: CircleCheck,
  inbox: Inbox,
  prs: GitPullRequest,
  snoozed: Clock3,
};

const entryClass = (selected: boolean, phone?: boolean) =>
  cn(
    "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 font-sans text-sm no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
    phone ? "h-11" : "h-8",
    selected
      ? "bg-dashboard-accent/[0.12] text-dashboard-accent-text"
      : "text-dashboard-text hover:bg-dashboard-fill-hover",
  );

function Entry(props: {
  count?: number;
  phone?: boolean;
  selected: boolean;
  /** The count waits on the viewer, so it shows in the accent. */
  strong?: boolean;
  view: InboxView;
}) {
  const Icon = ICONS[props.view];
  return (
    <li className="list-none">
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={entryClass(props.selected, props.phone)}
        // On a phone the Inbox entry needs `?view=`, since `/` alone lists
        // the entries.
        to={
          props.phone && props.view === "inbox"
            ? "/?view=inbox"
            : inboxViewPath(props.view)
        }
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4",
            props.selected ? "text-current" : "text-dashboard-text-muted",
          )}
          strokeWidth={1.9}
        />
        <span className="truncate font-medium">
          {INBOX_VIEW_LABELS[props.view]}
        </span>
        {props.count ? (
          props.strong ? (
            <span className="rounded-full bg-dashboard-accent px-1.5 text-2xs font-semibold leading-4 tabular-nums text-dashboard-text-inverse">
              {props.count}
            </span>
          ) : (
            <span className="text-xs tabular-nums text-dashboard-text-faint">
              {props.count}
            </span>
          )
        ) : null}
      </Link>
    </li>
  );
}

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
        className={entryClass(props.selected, props.phone)}
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
 * The Inbox sidebar, like Google Inbox: no list of Conversations, only the
 * entries that open a list in the main area. The Inbox, Snoozed, and Done
 * come first, then the bundles, then the Conversations in flight, running
 * or pinned, each one click away. Pins drag into a new order here.
 */
export function InboxNav(props: {
  /** On a phone the entries are a page, and each opens its list page. */
  phone?: boolean;
  selectedConversationId?: string;
}) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const data = useInboxData();
  const reorderPins = useReorderPinnedConversations();
  const { showActionError } = useConversationActionToasts();
  const onReorderError = useCallback(
    (conversation: Conversation) =>
      showActionError(conversation, "Could not reorder"),
    [showActionError],
  );
  const onList = pathname === "/" && (!props.phone || params.has("view"));
  const current = onList ? parseInboxView(params.get("view")) : undefined;
  const entry = (view: InboxView, strong?: boolean) => (
    <Entry
      count={data.counts[view]}
      key={view}
      phone={props.phone}
      selected={current === view}
      strong={strong}
      view={view}
    />
  );
  const pinnedShown = data.inFlight.filter(
    (conversation) => conversation.pinnedAt,
  );
  return (
    <nav
      aria-label="Inbox"
      className={cn(
        "thin-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain pb-6",
        props.phone ? "px-2 pt-2" : "px-3 pt-2",
      )}
    >
      <ul className="m-0 grid gap-0.5 p-0">
        {entry("inbox", true)}
        {data.signedIn ? (
          <>
            {entry("snoozed")}
            {entry("done")}
          </>
        ) : null}
      </ul>
      <h2 className="m-0 px-3 pt-5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
        Bundles
      </h2>
      <ul className="m-0 grid gap-0.5 p-0">
        {entry("conversations")}
        {data.signedIn ? (
          <>
            {entry("prs")}
            {entry("decisions")}
            {entry("automations", Boolean(data.counts.automations))}
          </>
        ) : null}
      </ul>
      {data.inFlightCount > 0 ? (
        <>
          <h2 className="m-0 flex items-baseline justify-between px-3 pt-5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
            In flight
            <span className="tabular-nums text-dashboard-text-faint">
              {data.inFlightCount}
            </span>
          </h2>
          {/* Every pin shows, so a drop can place them all. */}
          <PinnedConversationOrder
            conversations={pinnedShown}
            onError={onReorderError}
            reorder={reorderPins}
          >
            <ul aria-label="In flight" className="m-0 grid gap-0.5 p-0">
              {data.inFlight.map((conversation) => (
                <InFlightRow
                  conversation={conversation}
                  key={conversation.id}
                  phone={props.phone}
                  selected={props.selectedConversationId === conversation.id}
                />
              ))}
            </ul>
          </PinnedConversationOrder>
          <Link
            className="mt-1 ml-10 inline-block font-sans text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text hover:underline"
            to={inboxViewPath("conversations")}
          >
            Show all
          </Link>
        </>
      ) : null}
    </nav>
  );
}
