import {
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Pin,
  PinOff,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useHref, useNavigate } from "react-router";
import type {
  OwnedObjectAnnotation,
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";
import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { Button, buttonVariants } from "../components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "../components/ui/context-menu";
import { ConversationStatusText } from "../conversations/ConversationListStatusIcon";
import {
  ConversationStateIcon,
  conversationDisplayState,
} from "../conversations/ConversationStateIcon";
import {
  ConversationCast,
  useConversationDensity,
} from "../conversations/conversationDensity";
import { codeChangeSize } from "../codeChangeSize";
import { ChangeSize } from "../components/ChangeSize";
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
import { DisplayText } from "../display-text/DisplayText";
import { cn, dashboardSurfaceRadiusClass } from "../styles";
import type { Conversation } from "../types";
import { AskKindIcon } from "./askKind";
import { inboxItemKind } from "./inboxModel";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "./inboxRowStyles";
import { useAnimatedHeight } from "./rowMotion";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { InboxRowCard } from "./InboxRowCard";
import { askPills, Pill, type AskPill } from "./inboxAsks";
import { InboxFiles } from "./InboxFiles";
import { InboxImageStrip, type ImageWork } from "./InboxImageStrip";
import {
  InboxLinkCards,
  InboxLinkedWork,
  InboxLinkedWorkChips,
  isCard,
  LINKED_WORK_LIMIT,
  linkedWorkObjects,
  mainRepo,
  OPEN_LINKED_WORK_LIMIT,
  rankLinkedWork,
} from "./InboxLinkedWork";
import { isImageMedia } from "./useConversationImages";
import {
  RowActionButton,
  RowOpenLink,
  RowQuickActions,
  type InboxCardActions,
} from "./RowHoverActions";
import { RowSnoozeButton } from "./RowSnoozeDismiss";
import type { InboxBundle } from "./reviewItemFormat";
import { formatCompactAge } from "../time";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

const NO_ANNOTATIONS: NonNullable<Conversation["sidebarAnnotations"]> = [];
const NO_NOTICES: readonly ReviewItemPayload[] = [];

/** The second line: the summary, or the newest message when there is none. */
function rowSummary(conversation: Conversation | undefined) {
  if (conversation?.summary)
    return { mentions: undefined, text: conversation.summary };
  const preview = conversation?.activityPreview;
  if (!preview) return undefined;
  return { mentions: preview.mentions, text: preview.text };
}

/**
 * Where the row opens. A row for one item, as in a stack, opens the
 * Conversation that added it, also a child's, at the ask's record. A row for
 * a Conversation opens it, at its newest ask when that Conversation added it.
 */
function rowConversationPath(props: InboxRowProps): string {
  const newest = props.bundle?.newest;
  const id =
    newest && props.itemTitle !== undefined
      ? newest.addedByConversationId
      : props.conversationId;
  return conversationPath(id, {
    askItemId: newest?.addedByConversationId === id ? newest.id : undefined,
  });
}

type InboxRowProps = {
  /** What the viewer answered, such as "You answered Hold": the summary. */
  answered?: string;
  bundle?: InboxBundle;
  /** Each card's own actions, in a stack whose cards act by themselves. */
  cardActions?(item: ReviewItemPayload): InboxCardActions;
  /** A row with one ask shows its Snooze and Dismiss on hover. */
  itemActions?: boolean;
  conversation?: Conversation;
  conversationId: string;
  /** Set on a pinned row of a list that drags pins into a new order. */
  drag?: PinnedRowDrag;
  expanded: boolean;
  /** The notices that fold into each ask, by the ask's id. */
  foldedNotices?: ReadonlyMap<string, readonly ReviewItemPayload[]>;
  /** A row for one item leads with the item title. */
  itemTitle?: string;
  /** The second line of a row for one item (`itemRowSubtitle`). */
  itemSubtitle?: string;
  /** The size of the code change that a row for one item is about. */
  itemSize?: CodeChangeSize | undefined;
  /** Takes an ask's answer, Take, or Dismiss in place of its own action. */
  onItemAction?(
    item: ReviewItemPayload,
    body: ReviewItemActionBody,
  ): Promise<void>;
  /** Runs before a row action that can move rows, so its result shows. */
  onRowAction?(): void;
  onSnooze?(untilMs: number): void;
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
 * or Enter on the row opens the Conversation. Its ask pills expand it in
 * place, where each ask has its answer controls, then Open, Done, pin, and
 * snooze. A row for one item names the item, not the Conversation, so a
 * click on it expands it instead. A row of a loaded Conversation also has
 * the Conversation's context menu, Open, pin and archive on hover, and its
 * Threads.
 */
export function InboxRow(props: InboxRowProps) {
  // The rows below move with the row as it opens and closes.
  const cardRef = useRef<HTMLLIElement>(null);
  useAnimatedHeight(cardRef, String(props.expanded));
  const open = props.bundle?.items.filter((item) => item.status === "open");
  const quickActions =
    props.itemActions && open?.length === 1 && props.cardActions ? (
      <RowQuickActions
        actions={props.cardActions(open[0]!)}
        expanded={props.expanded}
        to={rowConversationPath(props)}
      />
    ) : undefined;
  return props.conversation ? (
    <ConversationInboxRow
      {...props}
      cardRef={cardRef}
      conversation={props.conversation}
      quickActions={quickActions}
    />
  ) : (
    <li
      className={cn(inboxCardClass(props.expanded), "group")}
      data-expanded={props.expanded || undefined}
      data-inbox-row={props.rowKey}
      ref={cardRef}
    >
      <InboxRowBody {...props} hoverActions={quickActions} />
    </li>
  );
}

/** The id of what a row's head opens. */
function rowRegionId(rowKey: string): string {
  return `inbox-row-${rowKey}`;
}

function ConversationInboxRow(
  props: InboxRowProps & {
    cardRef: RefObject<HTMLLIElement | null>;
    conversation: Conversation;
    /** A row with one ask acts on it instead of pinning or archiving. */
    quickActions?: ReactNode;
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
  // The row's own actions take the meta's place on hover or focus, in the
  // meta's cell, so they never cover the title or summary.
  const hoverActions = props.quickActions ?? (
    <>
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
    </>
  );
  return (
    <li
      className={cn(
        inboxCardClass(props.expanded),
        drag?.dragging && "opacity-40",
      )}
      data-expanded={props.expanded || undefined}
      data-inbox-row={props.rowKey}
      ref={props.cardRef}
    >
      <ContextMenu onOpenChange={actions.onMenuOpenChange}>
        <ContextMenuTrigger
          {...prefetch}
          {...drag?.listeners}
          className={cn("group relative min-w-0", dashboardSurfaceRadiusClass)}
          onKeyDown={drag?.onKeyDown}
          ref={drag?.setNodeRef}
        >
          <InboxRowBody
            {...props}
            actionsBelow={actionsBelow}
            hoverActions={hoverActions}
            threadsShown={hasThreads}
            linkProps={{
              "aria-keyshortcuts": drag
                ? "Alt+ArrowUp Alt+ArrowDown"
                : undefined,
              // The browser's own link drag would take the pointer from the
              // reorder.
              draggable: drag ? false : undefined,
            }}
          />
        </ContextMenuTrigger>
        {actions.menu}
      </ContextMenu>
      {threads && threads.threads.length > 0 ? (
        <div className="grid gap-0.5 px-1 pb-2">
          {threads.threads.map((thread) => (
            <ConversationSidebarThreadRow
              conversation={thread.conversation}
              depth={thread.depth}
              key={thread.conversation.id}
              onArchiveError={showArchiveError}
              onArchived={showArchived}
              onRowAction={props.onRowAction}
              selected={props.selected}
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
    <div
      className="flex min-w-0 text-sm leading-snug text-dashboard-text-muted"
      data-summary-lines={
        props.expanded ? "all" : props.comfortable ? "2" : "1"
      }
    >
      <div
        className={cn(
          "min-w-0",
          props.expanded
            ? "line-clamp-none"
            : props.comfortable
              ? "line-clamp-2"
              : "line-clamp-1",
        )}
      >
        {/* As messages show it: links show as chips, so the clamp ends on
            a word or a chip, not inside a URL. One line runs the
            paragraphs together; more lines keep them. */}
        <ReviewItemObjects
          cards={props.objects}
          conversationId={props.conversationId}
        >
          <DisplayText
            chips
            inline
            mentions={props.summary.mentions}
            paragraphs={props.expanded || props.comfortable}
            text={props.summary.text}
          />
        </ReviewItemObjects>
      </div>
    </div>
  );
}

function InboxRowBody(
  props: InboxRowProps & {
    /** The row's own actions, shown in the meta's place on hover. */
    hoverActions?: ReactNode;
    linkProps?: { "aria-keyshortcuts"?: string; draggable?: boolean };
    /** Whether the row lists its Threads under the head. */
    threadsShown?: boolean;
  },
) {
  const { bundle, conversation } = props;
  const navigate = useNavigate();
  // A row that names its Conversation opens it. A row for one item names
  // the item, and expands to show its answer controls.
  const opens = !props.itemTitle;
  const path = rowConversationPath(props);
  const href = useHref(path);
  // As a click on the head link does: a Ctrl/⌘ or Shift click, or a middle
  // click, opens a new tab.
  const openConversation = (event: MouseEvent) => {
    if (event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey)
      window.open(href, "_blank", "noopener");
    else void navigate(path);
  };
  const [density] = useConversationDensity();
  const comfortable = density === "comfortable";
  const openItems =
    bundle?.items.filter((item) => item.status === "open") ?? [];
  const annotations = conversation?.sidebarAnnotations ?? NO_ANNOTATIONS;
  // An item row's title already names its ask, so it shows no pill.
  const asks = props.itemTitle ? [] : askPills(openItems, annotations);
  const subjects = new Set(
    openItems.flatMap((item) => item.subject?.url ?? item.subject?.id ?? []),
  );
  const ranked = rankLinkedWork(annotations, subjects);
  // Comfortable rows show linked work with a preview image as an image
  // card, which carries its ask's icon in place of a pill.
  const imageWork: ImageWork[] = comfortable
    ? ranked.flatMap((annotation) =>
        isCard(annotation) && annotation.imageUrl
          ? [{ ...annotation, imageUrl: annotation.imageUrl }]
          : [],
      )
    : [];
  const imageUrls = new Set(imageWork.map((work) => work.url));
  const imageAsks = new Map<string, AskPill>();
  for (const pill of asks) {
    if (pill.url && imageUrls.has(pill.url)) imageAsks.set(pill.url, pill);
  }
  const pills = asks.filter((pill) => !imageAsks.has(pill.url ?? ""));
  // A change that a pill or an image card names shows once, there.
  const named = new Set([
    ...pills.flatMap((pill) => pill.url ?? []),
    ...imageUrls,
  ]);
  const work = ranked.filter((annotation) => !named.has(annotation.url ?? ""));
  const main = mainRepo(annotations);
  const waiting = bundle?.needsYou ?? false;
  const found = props.itemTitle ? undefined : rowSummary(conversation);
  // The viewer's answer replaces the line that asked for it.
  const summary = props.answered
    ? { mentions: undefined, text: props.answered }
    : found;
  const objects = useMemo(() => linkedWorkObjects(annotations), [annotations]);
  const limit = props.expanded ? OPEN_LINKED_WORK_LIMIT : LINKED_WORK_LIMIT;
  const media = conversation?.media ?? [];
  const files = media.filter((file) => !isImageMedia(file));
  // Message links fill what the linked work leaves of its lines.
  const links = (conversation?.links ?? []).slice(
    0,
    Math.max(0, limit - work.length),
  );
  const images = imageWork.length > 0 || media.some(isImageMedia);
  const regionId = rowRegionId(props.rowKey);
  // A closed row fits its title and subtitle to one line each. An open one
  // shows them in full, so its detail never needs to say them again.
  const lineClass = props.expanded ? "min-w-0 break-words" : fadeOverflowClass;
  // An item row's one card carries the row's actions on its own line.
  const inlineActions = Boolean(props.itemTitle) && openItems.length === 1;
  const asksShown =
    props.expanded && (openItems.length > 0 || !props.actionsBelow);
  // The head controls what it opens. `regionId` always wraps the row bar:
  // the asks hold it, or, after the Threads, the line that holds it does.
  const controls = props.actionsBelow
    ? `${asksShown ? `${regionId}-asks ` : ""}${regionId}`
    : regionId;
  const state = conversation
    ? conversationDisplayState(conversation)
    : undefined;
  // Comfortable rows show images, linked work, links and files under the
  // head.
  const cards =
    comfortable &&
    (images || work.length > 0 || files.length > 0 || links.length > 0);
  const hasChips = pills.length > 0 || (!cards && work.length > 0);
  const cast =
    comfortable && conversation ? (
      // The Threads list below counts the Threads, so the cast doesn't.
      <ConversationCast
        agents={!props.threadsShown}
        conversation={conversation}
      />
    ) : null;
  // A click on the row does what the head link does, except on the links
  // and buttons in it, such as pills, summary chips and images, or at the
  // end of a text selection.
  const rowClick = {
    onAuxClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 1 || !opens || onControl(event)) return;
      openConversation(event.nativeEvent);
    },
    // A middle press would start the browser's autoscroll, not the new tab
    // that its click opens.
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button === 1 && opens && !onControl(event))
        event.preventDefault();
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || onControl(event)) return;
      if (!opens) return props.onToggle();
      if (window.getSelection()?.isCollapsed === false) return;
      openConversation(event.nativeEvent);
    },
  };
  return (
    <>
      <div
        className={cn(
          "relative",
          dashboardSurfaceRadiusClass,
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
        {/* The head link is the row's keyboard target. */}
        <div
          className={cn(inboxHeadGridClass(), "cursor-pointer", "pb-3")}
          {...rowClick}
        >
          <span
            aria-label={
              waiting
                ? "Waiting on you"
                : openItems.length > 0
                  ? "Waiting on others"
                  : undefined
            }
            className={cn(
              "col-start-1 row-start-1 mt-[0.55rem] size-2 justify-self-center rounded-full",
              waiting
                ? "bg-dashboard-text"
                : openItems.length > 0
                  ? "border border-dashboard-text-faint"
                  : "",
            )}
            data-inbox-slot="dot"
            role={waiting || openItems.length > 0 ? "img" : undefined}
          />
          <span
            className="col-start-2 row-start-1 grid min-w-0 gap-1"
            data-inbox-slot="title"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Link
                {...props.linkProps}
                aria-controls={opens ? undefined : controls}
                aria-current={props.selected ? "page" : undefined}
                aria-expanded={opens ? undefined : props.expanded}
                className={cn(
                  "grid min-w-0 flex-1 gap-1 rounded-md font-sans text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
                  // A long press opens the row menu or drags a pin, not the iOS
                  // link callout.
                  "[-webkit-touch-callout:none]",
                )}
                data-inbox-head=""
                // On a row for one item, a plain click or Enter expands it in
                // place. A modified click keeps the link, so Ctrl/⌘-click
                // opens a new tab.
                onClick={(event) => {
                  if (
                    opens ||
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
                to={path}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-display text-base font-medium leading-snug text-dashboard-text">
                  {/* An item row's title names its kind; the icon marks it
                    the way the pills do. */}
                  {props.itemTitle && bundle ? (
                    <AskKindIcon kind={inboxItemKind(bundle.newest)} />
                  ) : null}
                  {/* The size wraps under the title where both do not fit. */}
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className={lineClass} ref={fadeWhenOverflowing}>
                      {props.itemTitle ?? props.title}
                    </span>
                    <ChangeSize size={props.itemSize} />
                  </span>
                </span>
                {props.itemTitle && props.itemSubtitle ? (
                  <span
                    className={cn(
                      lineClass,
                      "text-xs text-dashboard-text-muted",
                    )}
                    ref={fadeWhenOverflowing}
                  >
                    {props.itemSubtitle}
                  </span>
                ) : null}
              </Link>
            </span>
            {/* Who is in it and what it asks, in one small line under the
                title. */}
            {cast || hasChips ? (
              // No wrap: the pills and the linked work fit to one shared
              // line, and wrapping would let each one's fit move the other.
              <span className="flex min-w-0 items-center gap-2">
                {cast}
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
                          // A pill alone on its line shrinks and truncates
                          // its label, so a narrow row never cuts it off.
                          className="flex min-w-0 max-w-full cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
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
                          className="shrink-0 text-xs text-dashboard-text-faint"
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
          {summary ? (
            <div
              className="col-span-2 col-start-2 row-start-2 min-w-0"
              data-inbox-slot="summary"
            >
              <RowSummary
                comfortable={comfortable}
                conversationId={props.conversationId}
                expanded={props.expanded}
                objects={objects}
                summary={summary}
              />
            </div>
          ) : null}
          <span className={INBOX_ROW_META_CLASS} data-inbox-slot="meta">
            {/* The row's actions sit beside its state and never hide it.
                They keep their room while hidden, so nothing moves when
                they show: on hover or focus, and while the row is open. */}
            {props.hoverActions ? (
              <span
                className={cn(
                  "-my-1 flex gap-0.5 transition",
                  // A touch screen has no hover. In the Inbox, a row there
                  // shows its actions once it is open, so each row does not
                  // repeat them. Elsewhere they always show there.
                  !props.expanded &&
                    props.itemActions &&
                    "max-sm:hidden pointer-coarse:hidden",
                  !props.expanded &&
                    "sm:pointer-fine:pointer-events-none sm:pointer-fine:opacity-0 sm:pointer-fine:group-focus-within:pointer-events-auto sm:pointer-fine:group-focus-within:opacity-100 sm:pointer-fine:group-hover:pointer-events-auto sm:pointer-fine:group-hover:opacity-100",
                )}
              >
                {props.hoverActions}
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              {conversation ? (
                <ConversationStatusText
                  isPrivate={conversation.visibility === "private"}
                  status={conversation.status}
                />
              ) : null}
              <ConversationStateIcon state={state} />
              {state === "working" ? null : formatCompactAge(props.time)}
            </span>
          </span>
        </div>
        {cards ? (
          // Under the title, on its left edge: the images first, at preview
          // size, then the linked work, links and files, one line each.
          <div
            className="grid min-w-0 cursor-pointer gap-3 pr-4 pb-3 pl-8"
            {...rowClick}
          >
            {images ? (
              <InboxImageStrip
                askToggle={{
                  controls,
                  expanded: props.expanded,
                  onToggle: props.onToggle,
                }}
                asks={imageAsks}
                conversationId={props.conversationId}
                main={main}
                media={media}
                work={imageWork}
              />
            ) : null}
            {work.length > 0 ? (
              <InboxLinkedWork annotations={work} limit={limit} main={main} />
            ) : null}
            {links.length > 0 ? (
              <InboxLinkCards links={links} main={main} />
            ) : null}
            {files.length > 0 ? (
              <InboxFiles conversationId={props.conversationId} files={files} />
            ) : null}
          </div>
        ) : null}
      </div>
      {asksShown ? (
        <div
          aria-label={`${props.title}: asks`}
          className={cn(
            "grid min-w-0 gap-3",
            // An item row's detail starts on its title's left edge, with no
            // rule: the head and the detail are one card.
            inlineActions
              ? "pr-4 pb-4 pl-8"
              : "border-t border-dashboard-border px-3 pt-3 pb-3",
          )}
          id={props.actionsBelow ? `${regionId}-asks` : regionId}
          role="region"
        >
          {openItems.map((item) => (
            <InboxRowCard
              conversationId={props.conversationId}
              actions={props.cardActions?.(item)}
              headTitled={Boolean(props.itemTitle)}
              item={item}
              key={item.id}
              notices={props.foldedNotices?.get(item.id) ?? NO_NOTICES}
              onAction={props.onItemAction}
              rowActions={inlineActions ? rowActions(props, true) : undefined}
              sizeShown={codeChangeSize(props.itemSize) !== undefined}
              take={props.take}
            />
          ))}
          {props.actionsBelow || inlineActions ? null : rowActions(props)}
        </div>
      ) : null}
    </>
  );
}

/**
 * Whether a click on the row head belongs to something else: a control in
 * the head, or a popover that React bubbles through the head from a portal.
 */
function onControl(event: { currentTarget: Element; target: EventTarget }) {
  const { target } = event;
  return (
    !(target instanceof Element) ||
    !event.currentTarget.contains(target) ||
    Boolean(target.closest("a, button"))
  );
}

/** The open row's actions. `inline` gives them bare, for a card's line. */
function rowActions(props: InboxRowProps, inline = false) {
  return (
    <ExpandedActions
      conversation={props.conversation}
      inline={inline}
      // A stack of one card snoozes on the card.
      onSnooze={
        (props.bundle?.items.length ?? 0) > 1 ? props.onSnooze : undefined
      }
      onSnoozeMenu={props.onSnoozeMenu}
      onWake={props.onWake}
      openPath={rowConversationPath(props)}
      snoozeMenuOpen={props.snoozeMenuOpen}
    />
  );
}

function ExpandedActions(props: {
  conversation?: Conversation;
  inline: boolean;
  openPath: string;
  onSnooze?(untilMs: number): void;
  onSnoozeMenu(open: boolean): void;
  onWake?(): void;
  snoozeMenuOpen: boolean;
}) {
  const actions = (
    <>
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
          label="Snooze all"
          onOpenChange={props.onSnoozeMenu}
          onSnooze={props.onSnooze}
          open={props.snoozeMenuOpen}
        />
      ) : null}
    </>
  );
  if (props.inline) return actions;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {actions}
    </div>
  );
}

/** Pin the Conversation from the open row. There is one pin: its own. */
function ExpandedPin(props: { conversation: Conversation }) {
  const { clearActionError, showActionError } = useConversationActionToasts();
  const pin = usePinConversation(props.conversation.id, {
    onError: (pinning) =>
      showActionError(
        props.conversation,
        pinning ? "Could not pin" : "Could not unpin",
        () => pin.mutate(pinning),
      ),
    onSuccess: () => clearActionError(props.conversation),
  });
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
