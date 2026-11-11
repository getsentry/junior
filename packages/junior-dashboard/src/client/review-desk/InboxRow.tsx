import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Clock3,
  Pin,
  PinOff,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { ClampedPreview } from "../components/ClampedPreview";
import { Button } from "../components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "../components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { Spinner } from "../components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { BriefOutcomeMarker } from "../conversations/ConversationBrief";
import { formatCompactAge } from "../conversations/conversationAge";
import { ConversationStatusText } from "../conversations/ConversationListStatusIcon";
import { visualStatusForConversation } from "../format";
import {
  ConversationCast,
  useConversationDensity,
} from "../conversations/conversationDensity";
import { ConversationSidebarAnnotations } from "../conversations/ConversationMeta";
import { usePrefetchConversation } from "../conversations/conversationPrefetch";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  ConversationSidebarThreadRow,
  ConversationSidebarThreadToggle,
} from "../conversations/ConversationSidebarThreadRow";
import type { PinnedRowDrag } from "../conversations/PinnedConversationOrder";
import { sidebarThreads } from "../conversations/sidebarThreads";
import { useConversationRowActions } from "../conversations/useConversationRowActions";
import { usePinConversation } from "../conversations/usePinConversation";
import { DisplayText } from "../display-text/DisplayText";
import { displayPlainText } from "../display-text/plainText";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { inboxItemKind } from "./inboxModel";
import { inboxCardClass } from "./inboxRowStyles";
import { snoozeChoices, type SnoozeChoice } from "./inboxSnooze";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import { itemNeedsViewer, type InboxBundle } from "./reviewItemFormat";

const PLURALS: Record<string, string> = {
  Approval: "Approvals",
  Question: "Questions",
};

/** One ask pill: what an item asks of the viewer, such as "Approval". */
type AskPill = { key: string; label: string; strong: boolean };

/**
 * Name each open item the way the Inbox does: Question, Approval, the pull
 * request state with its number, or FYI. Repeats fold into a count.
 */
function askPills(items: readonly ReviewItemPayload[]): AskPill[] {
  const pills = new Map<string, AskPill & { count: number }>();
  for (const item of items) {
    if (item.status !== "open") continue;
    const kind = inboxItemKind(item);
    const number = /#\d+/.exec(item.title)?.[0];
    const isPullRequestState =
      kind === "Review requested" || kind === "Ready to merge";
    const label = isPullRequestState && number ? `${kind} ${number}` : kind;
    const current = pills.get(label);
    pills.set(label, {
      count: (current?.count ?? 0) + 1,
      key: label,
      label,
      strong: (current?.strong ?? false) || itemNeedsViewer(item),
    });
  }
  return [...pills.values()]
    .sort((a, b) => Number(b.strong) - Number(a.strong))
    .map((pill) => ({
      ...pill,
      label:
        pill.count > 1
          ? `${pill.count} ${PLURALS[pill.label] ?? pill.label}`
          : pill.label,
    }));
}

function Pill(props: { pill: AskPill }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-2xs font-semibold leading-none whitespace-nowrap",
        props.pill.strong
          ? "bg-dashboard-accent/15 text-dashboard-accent-text"
          : "border border-dashboard-border text-dashboard-text-muted",
      )}
    >
      {props.pill.label}
    </span>
  );
}

/** The second line: the Brief, or the newest message when there is none. */
function rowSummary(conversation: Conversation | undefined) {
  const brief = conversation?.brief;
  if (brief)
    return {
      line: displayPlainText(brief.summary || brief.intent),
      status: brief.status,
    };
  const preview = conversation?.activityPreview;
  if (!preview) return undefined;
  return {
    line: displayPlainText(preview.text, preview.mentions),
    status: undefined,
  };
}

function RowItem(props: { conversationId: string; item: ReviewItemPayload }) {
  const { item } = props;
  const showBody = item.kind === "notice" || !item.request;
  const kind = inboxItemKind(item);
  return (
    <section
      aria-label={item.title}
      className="grid min-w-0 gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-3 font-sans text-sm"
      data-inbox-item
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <Pill
          pill={{ key: kind, label: kind, strong: itemNeedsViewer(item) }}
        />
        <h4 className="m-0 min-w-0 truncate text-sm font-semibold text-dashboard-text">
          {item.title}
        </h4>
      </div>
      {showBody ? (
        <ClampedPreview className="leading-6" label={item.title} lines={4}>
          <DisplayText text={item.body} />
        </ClampedPreview>
      ) : null}
      {item.subject ? (
        <ReviewItemSubjectPreview
          conversationId={props.conversationId}
          subject={item.subject}
        />
      ) : null}
      <ReviewItemActions item={item} />
    </section>
  );
}

const ROW_ACTION_BUTTON_CLASS =
  "grid size-7 cursor-pointer place-items-center rounded-md bg-dashboard-surface-raised text-dashboard-text-muted transition hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed";

function RowActionButton(props: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick(): void;
  pressed?: boolean;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={props.label}
            aria-pressed={props.pressed}
            className={ROW_ACTION_BUTTON_CLASS}
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
          >
            {props.icon}
          </button>
        }
      />
      <TooltipContent size="compact">{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

type InboxRowProps = {
  bundle?: InboxBundle;
  conversation?: Conversation;
  conversationId: string;
  donePending?: boolean;
  /** Set on a pinned row of a list that drags pins into a new order. */
  drag?: PinnedRowDrag;
  expanded: boolean;
  /** A row for one item leads with the item title. */
  itemTitle?: string;
  onDone?(): void;
  /** Runs before a row action that can move rows, so its result shows. */
  onRowAction?(): void;
  onSnooze?(choice: SnoozeChoice): void;
  onSnoozeMenu(open: boolean): void;
  onToggle(): void;
  /** Set on a snoozed row: it wakes instead of snoozing. */
  onWake?(): void;
  rowKey: string;
  selected: boolean;
  /** Show the root's Threads under it, as the sidebar did. */
  showThreads?: boolean;
  snoozeMenuOpen: boolean;
  time: string;
  title: string;
};

/**
 * One Inbox row: a Conversation, with what it asks of the viewer. A click
 * on the row opens the Conversation in the main area. The ask pills, or the
 * chevron, expand the row in place, where each ask has its answer controls,
 * then Done, pin, and snooze. A row of a loaded Conversation also has the
 * Conversation's context menu, pin and archive on hover, and its Threads.
 */
export function InboxRow(props: InboxRowProps) {
  return props.conversation ? (
    <ConversationInboxRow {...props} conversation={props.conversation} />
  ) : (
    <li
      className={inboxCardClass(props.expanded)}
      data-inbox-row={props.rowKey}
    >
      <InboxRowBody {...props} />
    </li>
  );
}

function ConversationInboxRow(
  props: InboxRowProps & { conversation: Conversation },
) {
  const { conversation, drag } = props;
  const actions = useConversationRowActions(conversation, {
    onRowAction: props.onRowAction,
    selected: props.selected,
  });
  const { showArchiveError, showArchived } = useConversationActionToasts();
  const prefetch = usePrefetchConversation(conversation.id);
  const [threadsExpanded, setThreadsExpanded] = useState(false);
  const threads = props.showThreads
    ? sidebarThreads(conversation.threads, { expanded: threadsExpanded })
    : undefined;
  const participant = conversation.isParticipant;
  return (
    <li
      className={cn(
        inboxCardClass(props.expanded),
        drag?.dragging && "opacity-40",
      )}
      data-inbox-row={props.rowKey}
    >
      <ContextMenu onOpenChange={actions.onMenuOpenChange}>
        <ContextMenuTrigger
          {...prefetch}
          {...drag?.listeners}
          className="group relative min-w-0 rounded-xl"
          onKeyDown={drag?.onKeyDown}
          ref={drag?.setNodeRef}
        >
          <InboxRowBody
            {...props}
            linkProps={{
              "aria-keyshortcuts": drag
                ? "Alt+ArrowUp Alt+ArrowDown"
                : undefined,
              // The browser's own link drag would take the pointer from the
              // reorder.
              draggable: drag ? false : undefined,
            }}
          />
          {participant ? (
            <div className="absolute top-2 right-2 z-10 flex gap-0.5 transition sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100">
              {actions.archived ? null : (
                <RowActionButton
                  disabled={actions.pending.pin}
                  icon={
                    <Pin
                      aria-hidden="true"
                      fill={actions.pinned ? "currentColor" : "none"}
                      size={14}
                    />
                  }
                  label={`${actions.pinned ? "Unpin" : "Pin"} ${actions.title}`}
                  onClick={() => actions.setPinned(!actions.pinned)}
                  pressed={actions.pinned}
                  tooltip={actions.pinned ? "Unpin" : "Pin"}
                />
              )}
              <RowActionButton
                disabled={actions.pending.archive}
                icon={
                  actions.archived ? (
                    <ArchiveRestore aria-hidden="true" size={14} />
                  ) : (
                    <Archive aria-hidden="true" size={14} />
                  )
                }
                label={`${actions.archived ? "Restore" : "Archive"} ${actions.title}`}
                onClick={actions.toggleArchive}
                tooltip={actions.archived ? "Restore" : "Archive"}
              />
            </div>
          ) : null}
        </ContextMenuTrigger>
        {actions.menu}
      </ContextMenu>
      {threads && threads.threads.length > 0 ? (
        <div className="grid gap-0.5 px-1 pb-1.5">
          {threads.threads.map((thread) => (
            <ConversationSidebarThreadRow
              conversation={thread.conversation}
              depth={thread.depth}
              key={thread.conversation.id}
              onArchiveError={showArchiveError}
              onArchived={showArchived}
              onRowAction={props.onRowAction}
              selected={props.selected}
              waiting={false}
            />
          ))}
          {threads.collapsible &&
          (threadsExpanded || threads.hiddenCount > 0) ? (
            <ConversationSidebarThreadToggle
              expanded={threadsExpanded}
              hiddenCount={threads.hiddenCount}
              onToggle={() => setThreadsExpanded(!threadsExpanded)}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function InboxRowBody(
  props: InboxRowProps & {
    linkProps?: { "aria-keyshortcuts"?: string; draggable?: boolean };
  },
) {
  const { bundle, conversation } = props;
  const [density] = useConversationDensity();
  const comfortable = density === "comfortable";
  const openItems =
    bundle?.items.filter((item) => item.status === "open") ?? [];
  // An item row's title already names its ask, so it shows no pill.
  const pills = props.itemTitle ? [] : askPills(openItems);
  const waiting = bundle?.needsYou ?? false;
  const summary = props.itemTitle ? undefined : rowSummary(conversation);
  const annotations = conversation?.sidebarAnnotations ?? [];
  const canDone = openItems.some((item) => item.canAct);
  const canExpand = openItems.length > 0;
  const regionId = `inbox-row-${props.rowKey}`;
  const pinned = Boolean(conversation?.pinnedAt);
  const running = conversation?.status === "active";
  const expandLabel = `${props.expanded ? "Hide" : "Show"} asks in ${props.title}`;
  const hasChips = pills.length > 0 || annotations.length > 0 || canExpand;
  return (
    <>
      <div
        className={cn(
          "relative rounded-xl transition-colors hover:bg-dashboard-fill-hover",
          props.selected && "bg-dashboard-fill-soft",
          props.expanded && "rounded-b-none hover:bg-transparent",
        )}
      >
        {props.selected ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-dashboard-accent"
          />
        ) : null}
        <Link
          {...props.linkProps}
          aria-current={props.selected ? "page" : undefined}
          className={cn(
            "grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-xl px-3 pt-2.5 font-sans text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
            // A long press opens the row menu or drags a pin, not the iOS
            // link callout.
            "[-webkit-touch-callout:none]",
            hasChips ? "pb-1" : "pb-2.5",
          )}
          to={conversationPath(props.conversationId, {
            turnId: props.itemTitle ? bundle?.newest.addedByTurnId : undefined,
          })}
        >
          <span
            aria-label={waiting ? "Waiting on you" : undefined}
            className={cn(
              "mt-[0.45rem] size-2 rounded-full",
              waiting
                ? "bg-dashboard-accent"
                : openItems.length > 0
                  ? "border border-dashboard-text-faint"
                  : "",
            )}
            role={waiting ? "img" : undefined}
          />
          <span className="grid min-w-0 gap-1">
            <span className="min-w-0 truncate text-sm font-medium leading-snug text-dashboard-text">
              {props.itemTitle ?? props.title}
            </span>
            {props.itemTitle ? (
              <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
                {props.title}
              </span>
            ) : summary ? (
              <span className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-dashboard-text-muted">
                {summary.status ? (
                  <span className="mt-px">
                    <BriefOutcomeMarker status={summary.status} />
                  </span>
                ) : null}
                <span
                  className={cn(
                    "min-w-0",
                    props.expanded
                      ? "line-clamp-none"
                      : comfortable
                        ? "line-clamp-2"
                        : "line-clamp-1",
                  )}
                >
                  {summary.line}
                </span>
              </span>
            ) : null}
            {comfortable && conversation ? (
              <ConversationCast conversation={conversation} />
            ) : null}
          </span>
          <span className="flex items-center gap-1 pt-0.5 text-xs tabular-nums text-dashboard-text-faint">
            {conversation ? (
              <ConversationStatusText
                isPrivate={conversation.visibility === "private"}
                status={visualStatusForConversation(conversation)}
              />
            ) : null}
            {pinned ? (
              <Pin
                aria-label="Pinned"
                className="size-3 text-dashboard-accent-text"
                role="img"
              />
            ) : null}
            {running ? (
              <Spinner aria-label="Running" className="size-3.5" />
            ) : (
              formatCompactAge(props.time)
            )}
          </span>
        </Link>
        {hasChips ? (
          <div className="flex min-w-0 items-center gap-1 pr-2 pb-2 pl-[1.875rem]">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {pills.slice(0, 3).map((pill) => (
                <button
                  aria-controls={regionId}
                  aria-expanded={props.expanded}
                  className="cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
                  key={pill.key}
                  onClick={props.onToggle}
                  type="button"
                >
                  <Pill pill={pill} />
                </button>
              ))}
              {pills.length > 3 ? (
                <span className="text-2xs text-dashboard-text-faint">
                  +{pills.length - 3}
                </span>
              ) : null}
              <ConversationSidebarAnnotations annotations={annotations} />
            </span>
            {canExpand ? (
              <button
                aria-controls={regionId}
                aria-expanded={props.expanded}
                aria-label={expandLabel}
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-dashboard-text-muted transition hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                onClick={props.onToggle}
                title={expandLabel}
                type="button"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 transition-transform motion-reduce:transition-none",
                    props.expanded && "rotate-180",
                  )}
                />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.expanded ? (
        <div
          aria-label={`${props.title}: asks`}
          className="grid min-w-0 gap-3 border-t border-dashboard-border px-3 pt-3 pb-3"
          id={regionId}
          role="region"
        >
          {openItems.map((item) => (
            <RowItem
              conversationId={props.conversationId}
              item={item}
              key={item.id}
            />
          ))}
          <ExpandedActions
            canDone={canDone}
            conversation={conversation}
            donePending={props.donePending}
            onDone={props.onDone}
            onSnooze={props.onSnooze}
            onSnoozeMenu={props.onSnoozeMenu}
            onWake={props.onWake}
            snoozeMenuOpen={props.snoozeMenuOpen}
          />
        </div>
      ) : null}
    </>
  );
}

function ExpandedActions(props: {
  canDone: boolean;
  conversation?: Conversation;
  donePending?: boolean;
  onDone?(): void;
  onSnooze?(choice: SnoozeChoice): void;
  onSnoozeMenu(open: boolean): void;
  onWake?(): void;
  snoozeMenuOpen: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.canDone && props.onDone ? (
        <Button
          disabled={props.donePending}
          onClick={props.onDone}
          variant="quiet"
        >
          <Check aria-hidden="true" size={15} />
          Done
        </Button>
      ) : null}
      {props.conversation?.isParticipant ? (
        <ExpandedPin conversation={props.conversation} />
      ) : null}
      {props.onWake ? (
        <Button onClick={props.onWake} variant="quiet">
          <AlarmClockOff aria-hidden="true" size={15} />
          Wake
        </Button>
      ) : null}
      {props.onSnooze ? (
        <Popover onOpenChange={props.onSnoozeMenu} open={props.snoozeMenuOpen}>
          <PopoverTrigger
            render={
              <Button variant="quiet">
                <Clock3 aria-hidden="true" size={15} />
                Snooze
              </Button>
            }
          />
          <PopoverContent
            align="start"
            aria-label="Snooze until"
            className="grid w-48 gap-0.5 p-1"
          >
            {snoozeChoices.map((choice) => (
              <button
                className="cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left font-sans text-sm text-dashboard-text hover:bg-dashboard-fill-hover"
                key={choice.label}
                onClick={() => props.onSnooze?.(choice)}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/** Pin the Conversation from the open row. There is one pin: its own. */
function ExpandedPin(props: { conversation: Conversation }) {
  const pin = usePinConversation(props.conversation.id);
  const pinned = Boolean(props.conversation.pinnedAt);
  return (
    <Button
      aria-pressed={pinned}
      disabled={pin.isPending}
      onClick={() => pin.mutate(!pinned)}
      variant="quiet"
    >
      {pinned ? (
        <PinOff aria-hidden="true" size={15} />
      ) : (
        <Pin aria-hidden="true" size={15} />
      )}
      {pinned ? "Unpin" : "Pin"}
    </Button>
  );
}
