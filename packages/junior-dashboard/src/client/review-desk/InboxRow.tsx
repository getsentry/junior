import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  Clock3,
  Pin,
  PinOff,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  OwnedObjectAnnotation,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { Button, buttonVariants } from "../components/ui/button";
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
import {
  ATTENTION_TONE_CLASS,
  ConversationSidebarAnnotations,
  OPEN_TONE_CLASS,
} from "../conversations/ConversationMeta";
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
import { ClampedDisplayText, DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { inboxItemKind } from "./inboxModel";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "./inboxRowStyles";
import { snoozeChoices, type SnoozeChoice } from "./inboxSnooze";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import {
  InboxLinkCards,
  InboxLinkedWork,
  linkedWorkCardCount,
  linkedWorkObjects,
  MAX_ROW_PREVIEWS,
} from "./InboxLinkedWork";
import { InboxMedia } from "./InboxMedia";
import { ReviewItemTurnMessage } from "./ReviewItemTurnMessage";
import { itemNeedsViewer, type InboxBundle } from "./reviewItemFormat";

const NO_ANNOTATIONS: NonNullable<Conversation["sidebarAnnotations"]> = [];

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
      mentions: undefined,
      status: brief.status,
      text: brief.summary || brief.intent,
    };
  const preview = conversation?.activityPreview;
  if (!preview) return undefined;
  return {
    mentions: preview.mentions,
    status: undefined,
    text: preview.text,
  };
}

function RowItem(props: {
  conversationId: string;
  /** The row's own Done shows. */
  done: boolean;
  /** The row's head shows the item's title. */
  headTitled: boolean;
  item: ReviewItemPayload;
}) {
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
        {/* An item row's head already names the ask. A Conversation row's
            head names the Conversation, so each ask keeps its title. */}
        {props.headTitled ? null : (
          <h4 className="m-0 min-w-0 truncate text-sm font-semibold text-dashboard-text">
            {item.title}
          </h4>
        )}
      </div>
      <ReviewItemObjects conversationId={item.addedByConversationId}>
        {showBody ? (
          <ClampedDisplayText
            className="max-w-[80ch] leading-6"
            label={item.title}
            lines={4}
            text={item.body}
          />
        ) : null}
        {item.subject ? (
          <ReviewItemSubjectPreview
            body={showBody ? item.body : undefined}
            conversationId={props.conversationId}
            subject={item.subject}
          />
        ) : null}
      </ReviewItemObjects>
      {/* A notice's only action is Dismiss, the row's Done. A question keeps
          its own beside its answer. */}
      <ReviewItemActions dismiss={!(props.done && showBody)} item={item} />
      {item.request ? <ReviewItemTurnMessage item={item} /> : null}
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

/** The hover action that opens the row's Conversation in the main area. */
function RowOpenLink(props: { to: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The row names the Conversation; a search for its title finds
          // the row's head only.
          <Link
            aria-label="Open conversation"
            className={ROW_ACTION_BUTTON_CLASS}
            to={props.to}
          >
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        }
      />
      <TooltipContent size="compact">Open conversation</TooltipContent>
    </Tooltip>
  );
}

/** Where the row opens: at the record of its newest ask, when it has one. */
function rowConversationPath(props: InboxRowProps): string {
  return conversationPath(props.conversationId, {
    askItemId: props.bundle?.newest.id,
  });
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
  /** The second line of a row for one item (`itemRowSubtitle`). */
  itemSubtitle?: string;
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
  /** The row's Threads show the action bar on their last line instead. */
  actionsBelow?: boolean;
  snoozeMenuOpen: boolean;
  time: string;
  title: string;
};

/**
 * One Inbox row: a Conversation, with what it asks of the viewer. A click
 * or Enter on the row expands it in place, where each ask has its answer
 * controls, then Open, Done, pin, and snooze. Only Open, or a Ctrl/⌘-click
 * for a new tab, leaves the list. A row of a loaded Conversation also has
 * the Conversation's context menu, Open, pin and archive on hover, and its
 * Threads.
 */
export function InboxRow(props: InboxRowProps) {
  return props.conversation ? (
    <ConversationInboxRow {...props} conversation={props.conversation} />
  ) : (
    <li
      className={inboxCardClass(props.expanded)}
      data-expanded={props.expanded || undefined}
      data-inbox-row={props.rowKey}
    >
      <InboxRowBody {...props} />
    </li>
  );
}

/** The id of what a row's head opens. */
function rowRegionId(rowKey: string): string {
  return `inbox-row-${rowKey}`;
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
  const hasThreads = Boolean(threads && threads.threads.length > 0);
  // An open row's actions close the card: after its Threads, on the line of
  // "Show N more".
  const actionsBelow = props.expanded && hasThreads;
  const toggle =
    threads?.collapsible && (threadsExpanded || threads.hiddenCount > 0);
  return (
    <li
      className={cn(
        inboxCardClass(props.expanded),
        drag?.dragging && "opacity-40",
      )}
      data-expanded={props.expanded || undefined}
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
            actionsBelow={actionsBelow}
            linkProps={{
              "aria-keyshortcuts": drag
                ? "Alt+ArrowUp Alt+ArrowDown"
                : undefined,
              // The browser's own link drag would take the pointer from the
              // reorder.
              draggable: drag ? false : undefined,
            }}
          />
          <div className="absolute top-2 right-2 z-10 flex gap-0.5 transition sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100">
            <RowOpenLink to={rowConversationPath(props)} />
            {participant && !actions.archived ? (
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
            ) : null}
            {participant ? (
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
            ) : null}
          </div>
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
          {toggle || actionsBelow ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {toggle ? (
                <ConversationSidebarThreadToggle
                  expanded={threadsExpanded}
                  hiddenCount={threads.hiddenCount}
                  onToggle={() => setThreadsExpanded(!threadsExpanded)}
                />
              ) : null}
              {actionsBelow ? (
                <div className="ml-auto pr-2" id={rowRegionId(props.rowKey)}>
                  {rowActions(props)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RowSummary(props: {
  comfortable: boolean;
  conversationId: string;
  expanded: boolean;
  /** The row's linked work, so the summary's links show their chips. */
  objects: readonly OwnedObjectAnnotation[];
  summary: NonNullable<ReturnType<typeof rowSummary>>;
}) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-dashboard-text-muted">
      {props.summary.status ? (
        <span className="mt-px">
          <BriefOutcomeMarker status={props.summary.status} />
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0",
          props.expanded
            ? "line-clamp-none"
            : props.comfortable
              ? "line-clamp-3"
              : "line-clamp-1",
        )}
      >
        {/* As messages show it: links show as chips, so the clamp ends on
            a word or a chip, not inside a URL. */}
        <ReviewItemObjects
          cards={props.objects}
          conversationId={props.conversationId}
        >
          <DisplayText
            chips
            inline
            mentions={props.summary.mentions}
            text={props.summary.text}
          />
        </ReviewItemObjects>
      </span>
    </span>
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
  const annotations = conversation?.sidebarAnnotations ?? NO_ANNOTATIONS;
  const objects = useMemo(() => linkedWorkObjects(annotations), [annotations]);
  // One budget for the strip, in order: linked work (with any PR image),
  // then files, then cards for message links.
  const workCards = linkedWorkCardCount(annotations);
  const media = (conversation?.media ?? []).slice(
    0,
    MAX_ROW_PREVIEWS - workCards,
  );
  const links = (conversation?.links ?? []).slice(
    0,
    MAX_ROW_PREVIEWS - workCards - media.length,
  );
  const canDone = rowCanDone(props);
  const regionId = rowRegionId(props.rowKey);
  const asksShown =
    props.expanded && (openItems.length > 0 || !props.actionsBelow);
  // The head controls what it opens. `regionId` always wraps the row bar:
  // the asks hold it, or, after the Threads, the line that holds it does.
  const controls = props.actionsBelow
    ? `${asksShown ? `${regionId}-asks ` : ""}${regionId}`
    : regionId;
  const pinned = Boolean(conversation?.pinnedAt);
  const running = conversation?.status === "active";
  // Comfortable rows show files and linked work as cards in their own strip.
  const cards =
    comfortable &&
    (annotations.length > 0 || media.length > 0 || links.length > 0);
  const hasChips = pills.length > 0 || (!cards && annotations.length > 0);
  // A comfortable row with a summary reads in two columns on wider screens:
  // the title and people, then the summary beside them.
  const columns = comfortable && summary !== undefined;
  return (
    <>
      <div
        className={cn(
          "relative rounded-xl",
          props.selected && "bg-dashboard-fill-soft",
          props.expanded && "rounded-b-none",
        )}
      >
        {props.selected ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-dashboard-accent"
          />
        ) : null}
        {/* The head link is the row's keyboard target. A click anywhere else
            on the head expands the row too, except on the links and buttons
            in it, such as pills and summary chips. */}
        <div
          className={cn(
            inboxHeadGridClass(columns),
            "cursor-pointer",
            cards ? "pb-1" : "pb-2.5",
          )}
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("a, button")
            )
              return;
            props.onToggle();
          }}
        >
          <span
            aria-label={waiting ? "Waiting on you" : undefined}
            className={cn(
              "col-start-1 row-start-1 mt-[0.45rem] size-2 justify-self-center rounded-full",
              comfortable && "mt-[0.55rem]",
              waiting
                ? "bg-dashboard-accent"
                : openItems.length > 0
                  ? "border border-dashboard-text-faint"
                  : "",
            )}
            data-inbox-slot="dot"
            role={waiting ? "img" : undefined}
          />
          <span
            className="col-start-2 row-start-1 grid min-w-0 gap-1"
            data-inbox-slot="title"
          >
            <Link
              {...props.linkProps}
              aria-controls={controls}
              aria-current={props.selected ? "page" : undefined}
              aria-expanded={props.expanded}
              className={cn(
                "grid min-w-0 gap-1 rounded-md font-sans text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
                // A long press opens the row menu or drags a pin, not the iOS
                // link callout.
                "[-webkit-touch-callout:none]",
              )}
              // A plain click or Enter expands the row in place. A modified
              // click keeps the link, so Ctrl/⌘-click opens a new tab.
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                props.onToggle();
              }}
              to={rowConversationPath(props)}
            >
              <span
                className={cn(
                  "min-w-0 truncate font-medium leading-snug text-dashboard-text",
                  comfortable ? "text-base" : "text-sm",
                )}
              >
                {props.itemTitle ?? props.title}
              </span>
              {props.itemTitle && props.itemSubtitle ? (
                <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
                  {props.itemSubtitle}
                </span>
              ) : null}
              {comfortable && conversation ? (
                <ConversationCast conversation={conversation} />
              ) : null}
            </Link>
            {summary && !columns ? (
              <RowSummary
                comfortable={comfortable}
                conversationId={props.conversationId}
                expanded={props.expanded}
                objects={objects}
                summary={summary}
              />
            ) : null}
            {/* What the row asks sits right under its title and people. */}
            {hasChips ? (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {pills.slice(0, 3).map((pill) => (
                  <button
                    aria-controls={controls}
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
                {cards ? null : (
                  <ConversationSidebarAnnotations annotations={annotations} />
                )}
              </span>
            ) : null}
          </span>
          {columns ? (
            <span
              className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1 sm:pt-0.5"
              data-inbox-slot="summary"
            >
              <RowSummary
                comfortable
                conversationId={props.conversationId}
                expanded={props.expanded}
                objects={objects}
                summary={summary}
              />
            </span>
          ) : null}
          <span
            className={cn(
              INBOX_ROW_META_CLASS,
              columns && "sm:col-start-4",
              // The row actions take the meta's place on hover or focus.
              conversation &&
                "sm:group-hover:invisible sm:group-focus-within:invisible",
            )}
            data-inbox-slot="meta"
          >
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
        </div>
        {cards ? (
          <div
            className={cn(
              "grid min-w-0 gap-2 pr-2 pb-2.5 pl-[1.875rem]",
              columns && "sm:pl-[calc(1.875rem+var(--inbox-lead)+0.625rem)]",
            )}
          >
            {annotations.length > 0 ? (
              <InboxLinkedWork annotations={annotations} />
            ) : null}
            {media.length > 0 ? (
              <InboxMedia conversationId={props.conversationId} media={media} />
            ) : null}
            {links.length > 0 ? <InboxLinkCards links={links} /> : null}
          </div>
        ) : null}
      </div>
      {asksShown ? (
        <div
          aria-label={`${props.title}: asks`}
          className="grid min-w-0 gap-3 border-t border-dashboard-border px-3 pt-3 pb-3"
          id={props.actionsBelow ? `${regionId}-asks` : regionId}
          role="region"
        >
          {openItems.map((item) => (
            <RowItem
              conversationId={props.conversationId}
              done={canDone && Boolean(props.onDone)}
              headTitled={Boolean(props.itemTitle)}
              item={item}
              key={item.id}
            />
          ))}
          {props.actionsBelow ? null : rowActions(props)}
        </div>
      ) : null}
    </>
  );
}

function rowCanDone(props: InboxRowProps): boolean {
  return (
    props.bundle?.items.some((item) => item.status === "open" && item.canAct) ??
    false
  );
}

function rowActions(props: InboxRowProps) {
  return (
    <ExpandedActions
      canDone={rowCanDone(props)}
      conversation={props.conversation}
      donePending={props.donePending}
      onDone={props.onDone}
      onSnooze={props.onSnooze}
      onSnoozeMenu={props.onSnoozeMenu}
      onWake={props.onWake}
      openPath={rowConversationPath(props)}
      snoozeMenuOpen={props.snoozeMenuOpen}
    />
  );
}

function ExpandedActions(props: {
  canDone: boolean;
  conversation?: Conversation;
  openPath: string;
  donePending?: boolean;
  onDone?(): void;
  onSnooze?(choice: SnoozeChoice): void;
  onSnoozeMenu(open: boolean): void;
  onWake?(): void;
  snoozeMenuOpen: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Link
        className={buttonVariants({ variant: "ghost" })}
        to={props.openPath}
      >
        <ArrowUpRight aria-hidden="true" size={15} />
        Open conversation
      </Link>
      {props.conversation?.isParticipant ? (
        <ExpandedPin conversation={props.conversation} />
      ) : null}
      {props.onWake ? (
        <Button onClick={props.onWake} variant="ghost">
          <AlarmClockOff aria-hidden="true" size={15} />
          Wake
        </Button>
      ) : null}
      {props.onSnooze ? (
        <Popover onOpenChange={props.onSnoozeMenu} open={props.snoozeMenuOpen}>
          <PopoverTrigger
            render={
              <Button variant="ghost">
                <Clock3
                  aria-hidden="true"
                  className={ATTENTION_TONE_CLASS}
                  size={15}
                />
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
      {/* The main action is the right-most one. */}
      {props.canDone && props.onDone ? (
        <Button
          disabled={props.donePending}
          onClick={props.onDone}
          variant="outline"
        >
          <Check aria-hidden="true" className={OPEN_TONE_CLASS} size={15} />
          Done
        </Button>
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
      variant="ghost"
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
