import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Pin,
  PinOff,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  OwnedObjectAnnotation,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { Button, buttonVariants } from "../components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "../components/ui/context-menu";
import { Spinner } from "../components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { BriefOutcomeMarker } from "../conversations/ConversationBrief";
import { ConversationStatusText } from "../conversations/ConversationListStatusIcon";
import { visualStatusForConversation } from "../format";
import {
  ConversationCast,
  useConversationDensity,
} from "../conversations/conversationDensity";
import { FittingIcons } from "../conversations/ConversationMeta";
import { usePrefetchConversation } from "../conversations/conversationPrefetch";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  ConversationSidebarThreadRow,
  ConversationSidebarThreadToggle,
} from "../conversations/ConversationSidebarThreadRow";
import type { PinnedRowDrag } from "../conversations/PinnedConversationOrder";
import { sidebarThreads } from "../conversations/sidebarThreads";
import { useInboxRowActions } from "../conversations/useInboxRowActions";
import { usePinConversation } from "../conversations/usePinConversation";
import { ClampedDisplayText, DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { objectPresentation } from "@sentry/junior-plugin-api";
import { objectToneClass } from "../components/ObjectIcon";
import { AskKindIcon, askLook } from "./askKind";
import { inboxItemKind } from "./inboxModel";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "./inboxRowStyles";
import { useHoverExpandAllowed } from "./hoverExpand";
import { useInboxRowFocused } from "./inboxFocus";
import { useAnimatedHeight } from "./rowMotion";
import type { SnoozeChoice } from "./inboxSnooze";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import {
  InboxLinkCards,
  InboxLinkedWork,
  InboxLinkedWorkChips,
  linkedWorkCardCount,
  linkedWorkObjects,
  MAX_ROW_PREVIEWS,
} from "./InboxLinkedWork";
import { InboxMedia } from "./InboxMedia";
import { ReviewItemTurnMessage } from "./ReviewItemTurnMessage";
import { RowDismissButton, RowSnoozeButton } from "./RowSnoozeDismiss";
import { itemNeedsViewer, type InboxBundle } from "./reviewItemFormat";
import { formatCompactAge } from "../time";

const NO_ANNOTATIONS: NonNullable<Conversation["sidebarAnnotations"]> = [];

const PLURALS: Record<string, string> = {
  Approval: "Approvals",
  Question: "Questions",
};

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];

/**
 * One ask pill: what an item asks of the viewer, such as "Question". A pull
 * request ask also names its change, so the change needs no chip of its own.
 */
type AskPill = {
  count: number;
  key: string;
  kind: string;
  /** The full name, such as "Review requested #91: Pin the release train". */
  name: string;
  /** The change's number, such as #91, in its status color. */
  ref?: { number: string; tone?: string };
  strong: boolean;
  /** The change's title, or the kind's name for an ask with no change. */
  label?: string;
  /** The change's URL, which its chip would have linked. */
  url?: string;
};

// The change a pull request ask names: its saved linked work when the
// Conversation has it, else the item's own subject.
function askChange(
  item: ReviewItemPayload,
  annotations: readonly Annotation[],
) {
  const url = item.subject?.url ?? item.subject?.id;
  const work = url
    ? annotations.find((annotation) => annotation.url === url)
    : undefined;
  const subjectTitle = item.subject?.title;
  // A subject titled by its key, such as owner/repo#123, adds nothing to #123.
  const title =
    work?.title ??
    (subjectTitle && !/^[\w.-]+\/[\w.-]+#\d+$/.test(subjectTitle)
      ? subjectTitle
      : undefined);
  const tone = work?.objectType
    ? objectToneClass[
        objectPresentation({ objectType: work.objectType, status: work.status })
          .tone
      ]
    : undefined;
  return { title, tone, url };
}

/**
 * Name each open item the way the Inbox does: Question, Approval, the pull
 * request state with its change, or FYI. Repeats fold into a count.
 */
function askPills(
  items: readonly ReviewItemPayload[],
  annotations: readonly Annotation[],
): AskPill[] {
  const pills = new Map<string, AskPill>();
  for (const item of items) {
    if (item.status !== "open") continue;
    const kind = inboxItemKind(item);
    const number = /#\d+/.exec(item.title)?.[0];
    const isPullRequestState =
      kind === "Review requested" || kind === "Ready to merge";
    const key = isPullRequestState && number ? `${kind} ${number}` : kind;
    const current = pills.get(key);
    const strong = (current?.strong ?? false) || itemNeedsViewer(item);
    if (isPullRequestState && number) {
      const change = askChange(item, annotations);
      pills.set(key, {
        count: 1,
        key,
        kind,
        name: change.title ? `${key}: ${change.title}` : key,
        label: change.title,
        ref: { number, tone: change.tone },
        strong,
        url: change.url,
      });
      continue;
    }
    const count = (current?.count ?? 0) + 1;
    const name = count > 1 ? `${count} ${PLURALS[kind] ?? kind}` : kind;
    pills.set(key, {
      count,
      key,
      kind,
      name,
      strong,
      // An FYI asks nothing, so its icon is enough.
      label: kind === "FYI" ? (count > 1 ? String(count) : undefined) : name,
    });
  }
  return [...pills.values()].sort(
    (a, b) => Number(b.strong) - Number(a.strong),
  );
}

// The icon carries the kind, so the words name only what it is about.
function Pill(props: { pill: AskPill }) {
  const { pill } = props;
  const look = askLook(pill.kind);
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-60 shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs leading-none whitespace-nowrap",
        pill.strong
          ? cn(look?.tint ?? "bg-dashboard-fill-soft", "text-dashboard-text")
          : "border border-dashboard-border text-dashboard-text-muted",
      )}
      data-ask-pill={pill.kind}
    >
      <AskKindIcon className="size-3" kind={pill.kind} />
      {pill.label ? (
        <span className="min-w-0 truncate font-medium">{pill.label}</span>
      ) : null}
      {pill.ref ? (
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            pill.ref.tone ?? "text-dashboard-text-muted",
          )}
        >
          {pill.ref.number}
        </span>
      ) : null}
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
  take?: string;
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
          pill={{
            count: 1,
            key: kind,
            kind,
            name: kind,
            label: kind,
            strong: itemNeedsViewer(item),
          }}
        />
        {/* An item row's head already names the ask. A Conversation row's
            head names the Conversation, so each ask keeps its title. */}
        {props.headTitled ? null : (
          <h4 className="m-0 min-w-0 truncate text-sm font-semibold text-dashboard-text">
            {item.title}
          </h4>
        )}
      </div>
      {/* What Junior said comes first, then its question and the form. */}
      {item.request ? <ReviewItemTurnMessage item={item} /> : null}
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
      {/* The row's bar holds Dismiss. A card on its own, as in a
          Conversation, keeps its own. */}
      <ReviewItemActions
        dismiss={!props.done}
        item={item}
        take={props.take ?? false}
      />
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
  /** Label of each ask's take button. Only Up for grabs offers one. */
  take?: string;
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
  const motion = useRowMotion(props);
  return props.conversation ? (
    <ConversationInboxRow
      {...props}
      conversation={props.conversation}
      motion={motion}
    />
  ) : (
    <li
      className={inboxCardClass(props.expanded)}
      data-expanded={props.expanded || undefined}
      data-grown={motion.grown || undefined}
      data-inbox-row={props.rowKey}
      ref={motion.ref}
    >
      <InboxRowBody {...props} preview={motion.grown} />
    </li>
  );
}

/**
 * How a row moves with the pointer. In focus, a row that may expand on
 * hover shows its comfortable layout, whole summary and every preview in
 * place, and the rows below move down with it.
 */
function useRowMotion(props: InboxRowProps) {
  const focused = useInboxRowFocused(props.rowKey);
  const grown = useHoverExpandAllowed() && focused && !props.expanded;
  const ref = useRef<HTMLLIElement>(null);
  useAnimatedHeight(ref, `${props.expanded}:${grown}`);
  return { grown, ref };
}

/** The id of what a row's head opens. */
function rowRegionId(rowKey: string): string {
  return `inbox-row-${rowKey}`;
}

function ConversationInboxRow(
  props: InboxRowProps & {
    conversation: Conversation;
    motion: ReturnType<typeof useRowMotion>;
  },
) {
  const { conversation, drag } = props;
  const actions = useInboxRowActions(conversation, {
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
      data-grown={props.motion.grown || undefined}
      data-inbox-row={props.rowKey}
      ref={props.motion.ref}
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
            preview={props.motion.grown}
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
          // Links read as the summary's own words, and underline on hover,
          // so a line of links does not shout over the title.
          "[&_a]:font-normal [&_a]:text-dashboard-text [&_a]:no-underline [&_a:hover]:underline",
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
    /** In focus on hover: comfortable, unclamped, every preview. */
    preview?: boolean;
  },
) {
  const { bundle, conversation, preview } = props;
  const [density] = useConversationDensity();
  const comfortable = Boolean(preview) || density === "comfortable";
  const budget = preview ? Infinity : MAX_ROW_PREVIEWS;
  const openItems =
    bundle?.items.filter((item) => item.status === "open") ?? [];
  const annotations = conversation?.sidebarAnnotations ?? NO_ANNOTATIONS;
  // An item row's title already names its ask, so it shows no pill.
  const pills = props.itemTitle ? [] : askPills(openItems, annotations);
  // A change that a pill names shows once, in its pill.
  const named = new Set(pills.flatMap((pill) => pill.url ?? []));
  const work =
    named.size === 0
      ? annotations
      : annotations.filter((annotation) => !named.has(annotation.url ?? ""));
  const waiting = bundle?.needsYou ?? false;
  const summary = props.itemTitle ? undefined : rowSummary(conversation);
  const objects = useMemo(() => linkedWorkObjects(annotations), [annotations]);
  // One budget for the strip, in order: linked work (with any PR image),
  // then files, then cards for message links.
  const workCards = preview ? 0 : linkedWorkCardCount(work);
  const media = (conversation?.media ?? []).slice(0, budget - workCards);
  const links = (conversation?.links ?? []).slice(
    0,
    budget - workCards - media.length,
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
    comfortable && (work.length > 0 || media.length > 0 || links.length > 0);
  const hasChips = pills.length > 0 || (!cards && work.length > 0);
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
                  "flex min-w-0 items-center gap-1.5 font-medium leading-snug text-dashboard-text",
                  comfortable ? "text-base" : "text-sm",
                )}
              >
                {/* An item row's title names its kind; the icon marks it
                    the way the pills do. */}
                {props.itemTitle && bundle ? (
                  <AskKindIcon kind={inboxItemKind(bundle.newest)} />
                ) : null}
                <span className="min-w-0 truncate">
                  {props.itemTitle ?? props.title}
                </span>
              </span>
              {props.itemTitle && props.itemSubtitle ? (
                <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
                  {props.itemSubtitle}
                </span>
              ) : null}
              {comfortable && conversation ? (
                // A compact row that grows under the pointer keeps the name
                // it reads under.
                <span
                  aria-hidden={density === "compact" || undefined}
                  className="contents"
                >
                  <ConversationCast conversation={conversation} />
                </span>
              ) : null}
            </Link>
            {summary && !columns ? (
              <RowSummary
                comfortable={comfortable}
                conversationId={props.conversationId}
                expanded={props.expanded || Boolean(preview)}
                objects={objects}
                summary={summary}
              />
            ) : null}
            {/* What the row asks sits right under its title and people. */}
            {hasChips ? (
              // No wrap: the pills and the linked work fit to one shared
              // line, and wrapping would let each one's fit move the other.
              <span className="flex min-w-0 items-center gap-1">
                {pills.length > 0 ? (
                  // One line of pills: those that do not fit become +N.
                  <span className="flex min-w-0 max-w-full items-center gap-1">
                    <FittingIcons
                      // The padding keeps focus rings inside the clipped line.
                      className="-m-0.5 h-6 min-w-0 gap-x-1 p-0.5"
                      icons={pills.map((pill) => (
                        <button
                          aria-controls={controls}
                          aria-expanded={props.expanded}
                          aria-label={pill.name}
                          className="shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
                          key={pill.key}
                          onClick={props.onToggle}
                          title={pill.name}
                          type="button"
                        >
                          <Pill pill={pill} />
                        </button>
                      ))}
                      overflow={(count) => (
                        <span
                          className="shrink-0 text-2xs text-dashboard-text-faint"
                          data-pill-overflow=""
                        >
                          +{count}
                        </span>
                      )}
                    />
                  </span>
                ) : null}
                {cards ? null : <InboxLinkedWorkChips annotations={work} />}
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
                expanded={props.expanded || Boolean(preview)}
                objects={objects}
                summary={summary}
              />
            </span>
          ) : null}
          <span
            className={cn(
              INBOX_ROW_META_CLASS,
              columns && "sm:col-start-4",
              // The row actions take the meta's place on hover or focus,
              // over the hover card too.
              conversation &&
                (preview
                  ? "invisible"
                  : "sm:group-hover:invisible sm:group-focus-within:invisible"),
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
            {work.length > 0 ? (
              <InboxLinkedWork all={preview} annotations={work} />
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
              take={props.take}
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
        <RowSnoozeButton
          onOpenChange={props.onSnoozeMenu}
          onSnooze={props.onSnooze}
          open={props.snoozeMenuOpen}
        />
      ) : null}
      {/* The main action is the right-most one. */}
      {props.canDone && props.onDone ? (
        <RowDismissButton disabled={props.donePending} onClick={props.onDone} />
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
