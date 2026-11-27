import { AlarmClockOff, Archive, ArchiveRestore, Pin } from "lucide-react";
import { useMemo, useState, type ReactNode, type RefCallback } from "react";
import { Link } from "react-router";
import type {
  InboxItemActionBody,
  InboxItemPayload,
  InboxSnoozeWake,
} from "@sentry/junior/api/schema";

import { ToggleSheet } from "../components/BottomSheet";
import { Button } from "../components/ui/button";
import {
  browserMenuOnLinks,
  ContextMenu,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { ConversationStatusText } from "../conversations/ConversationListStatusIcon";
import {
  ConversationStateIcon,
  conversationDisplayState,
} from "../conversations/ConversationStateIcon";
import {
  ConversationCast,
  useConversationDensity,
} from "../conversations/conversationDensity";
import { ChangeSize } from "../components/ChangeSize";
import { FittingIcons } from "../conversations/ConversationMeta";
import { usePrefetchConversation } from "../conversations/conversationPrefetch";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  ConversationSidebarThreadRow,
  ConversationSidebarThreadToggle,
  ConversationSidebarThreadsOmitted,
} from "../conversations/ConversationSidebarThreadRow";
import { sidebarThreads } from "../conversations/sidebarThreads";
import { useInboxRowActions } from "../conversations/useInboxRowActions";
import { NearScreenObjects, useNearScreen } from "../display-text/DisplayText";
import { useMobileLayout } from "../layoutMedia";
import { cn, dashboardSurfaceRadiusClass } from "../styles";
import type { Conversation } from "../types";
import { AskKindIcon } from "./askKind";
import type { CodeChangeHead } from "./codeChangeHead";
import {
  CodeChangeOpenButton,
  CodeChangeOpenLink,
  CodeChangeSubtitle,
  CodeChangeTitle,
} from "./CodeChangeTitle";
import { useCodeChangeFacts } from "./InboxItemSubjectPreview";
import { inboxItemKind, itemKindActions } from "./inboxModel";
import {
  INBOX_ROW_META_CLASS,
  inboxCardClass,
  inboxHeadGridClass,
} from "./inboxRowStyles";
import { openOnClick, useOpenPath } from "./rowClick";
import { useAnimatedHeight } from "./rowMotion";
import { RowSummary, rowSummary } from "./InboxRowSummary";
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
import { ButtonLabel, LOOK_CLASSES, type ButtonLook } from "./RowDismissButton";
import { ExpandedPin } from "./ExpandedPin";
import {
  ReplyNoticeLink,
  RowOwnerLink,
  type RowOpenTarget,
} from "./RowOwnerLink";
import { RowSnoozeButton } from "./RowSnoozeDismiss";
import type { EventSnooze } from "./snoozeChoices";
import { wakeReasonText } from "./snoozeSentences";
import type { InboxBundle } from "./inboxItemFormat";
import { formatCompactAge } from "../time";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { SpaceChip } from "../spaces/SpaceTile";
import {
  itemConversationId,
  itemOwnerLinkLabel,
  itemConversationHidden,
  itemOwnerPath,
} from "./inboxItemFormat";

const NO_ANNOTATIONS: NonNullable<Conversation["sidebarAnnotations"]> = [];
const NO_NOTICES: readonly InboxItemPayload[] = [];

/**
 * Where the row opens. A row for one item, as in a stack, opens the item's
 * owner: the Conversation that added it, also a child's, at the ask's
 * record, or its Automation. So does the row of an owner that is not a
 * Conversation. A row for a Conversation opens it, at its newest ask when
 * that Conversation added it.
 */
function rowOpenTarget(props: InboxRowProps): RowOpenTarget {
  const newest = props.bundle?.newest;
  const id = props.conversationId;
  if (newest && (props.itemTitle !== undefined || id === undefined))
    return {
      automation: newest.owner.kind === "automation",
      label: itemOwnerLinkLabel(newest),
      onClick: props.onOpen,
      path: itemOwnerPath(newest, { askItemId: newest.id }),
    };
  return {
    automation: false,
    label: "Open conversation",
    onClick: props.onOpen,
    path: conversationPath(id!, {
      askItemId:
        newest && itemConversationId(newest) === id ? newest.id : undefined,
    }),
  };
}

type InboxRowProps = {
  /** What the viewer answered, such as "You answered Hold": the summary. */
  answered?: string;
  bundle?: InboxBundle;
  /** Each card's own actions, in a stack whose cards act by themselves. */
  cardActions?(item: InboxItemPayload): InboxCardActions;
  /** A row with one ask shows its Snooze and Dismiss on hover. */
  itemActions?: boolean;
  conversation?: Conversation;
  /**
   * The row's root Conversation. Undefined for the stack of an owner that
   * is not a Conversation, which always has a `bundle`.
   */
  conversationId: string | undefined;
  expanded: boolean;
  /** The notices that fold into each ask, by the ask's id. */
  foldedNotices?: ReadonlyMap<string, readonly InboxItemPayload[]>;
  /** A row for one item leads with the item title. */
  itemTitle?: string;
  /** The second line of a row for one item (`itemRowSubtitle`). */
  itemSubtitle?: string;
  /** A row for one code change item leads with the change's title. */
  itemHead?: CodeChangeHead | undefined;
  /** Takes an ask's answer, Take, or Dismiss in place of its own action. */
  onItemAction?(
    item: InboxItemPayload,
    body: InboxItemActionBody,
  ): Promise<void>;
  /** Runs before a row action that can move rows, so its result shows. */
  onRowAction?(): void;
  onSnooze?(untilMs: number): void;
  /** Snooze on an Event of the subject that the row's items share. */
  eventSnooze?: EventSnooze | undefined;
  onSnoozeMenu(open: boolean): void;
  onToggle(): void;
  /** Set on a snoozed row: it wakes instead of snoozing. */
  onWake?(): void;
  /** Runs when the row opens what it names, such as its Conversation. */
  onOpen?(): void;
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
  /** Why the viewer's snooze of an item in the row woke. */
  wake?: InboxSnoozeWake | undefined;
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
export function InboxRow(rowProps: InboxRowProps) {
  // A phone has no room to open a row in place: an open row shows its asks
  // in a sheet, and the row itself stays closed.
  const mobile = useMobileLayout();
  const props = mobile ? { ...rowProps, expanded: false } : rowProps;
  const sheetOpen = mobile ? rowProps.expanded : undefined;
  // A row reads the live cards of its links once it comes near the screen.
  const card = useNearScreen<HTMLLIElement>();
  // The rows below move with the row as it opens and closes.
  useAnimatedHeight(card.element, String(props.expanded));
  const open = props.bundle?.items.filter((item) => item.status === "open");
  const quickActions =
    props.itemActions && open?.length === 1 && props.cardActions ? (
      <RowQuickActions
        actions={props.cardActions(open[0]!)}
        // An open row's card has the actions, also in a phone's sheet.
        expanded={rowProps.expanded}
        main={
          props.itemHead ? (
            <CodeChangeOpenLink head={props.itemHead} />
          ) : undefined
        }
        onExpand={props.onToggle}
      />
    ) : undefined;
  return (
    <NearScreenObjects near={card.near}>
      {props.conversation ? (
        <ConversationInboxRow
          {...props}
          cardRef={card.ref}
          conversation={props.conversation}
          quickActions={quickActions}
          sheetOpen={sheetOpen}
        />
      ) : (
        <li
          className={cn(inboxCardClass(props.expanded), "group")}
          data-expanded={props.expanded || undefined}
          data-inbox-row={props.rowKey}
          ref={card.ref}
        >
          <InboxRowBody
            {...props}
            hoverActions={quickActions}
            sheetOpen={sheetOpen}
          />
        </li>
      )}
    </NearScreenObjects>
  );
}

/** The id of what a row's head opens. */
function rowRegionId(rowKey: string): string {
  return `inbox-row-${rowKey}`;
}

function ConversationInboxRow(
  props: InboxRowProps & {
    cardRef: RefCallback<HTMLLIElement>;
    conversation: Conversation;
    /** A row with one ask acts on it instead of pinning or archiving. */
    quickActions?: ReactNode;
    sheetOpen: boolean | undefined;
  },
) {
  const { conversation } = props;
  const actions = useInboxRowActions(conversation, {
    onRowAction: props.onRowAction,
    selected: props.selected,
  });
  const { showArchiveError, showArchived } = useConversationActionToasts();
  const prefetch = usePrefetchConversation(conversation.id);
  const [threadsExpanded, setThreadsExpanded] = useState(false);
  const threads = props.showThreads
    ? sidebarThreads(conversation, { expanded: threadsExpanded })
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
      {/* Archive, Pin, then Open last, in the order of an item row's
          actions. */}
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
      <RowOpenLink {...rowOpenTarget(props)} />
    </>
  );
  return (
    <li
      className={inboxCardClass(props.expanded)}
      data-expanded={props.expanded || undefined}
      data-inbox-row={props.rowKey}
      ref={props.cardRef}
    >
      {/* A closed card opens the menu anywhere on it. An open card opens it
          only from its title, so its text selects and the browser menu
          works there. Both stay mounted, so a toggle keeps focus. */}
      <ContextMenu
        disabled={props.expanded}
        onOpenChange={actions.onMenuOpenChange}
      >
        <ContextMenuTrigger
          {...prefetch}
          {...browserMenuOnLinks}
          className={cn(
            "group relative min-w-0",
            dashboardSurfaceRadiusClass,
            props.expanded && "select-text",
          )}
        >
          <InboxRowBody
            {...props}
            actionsBelow={actionsBelow}
            hoverActions={hoverActions}
            sheetOpen={props.sheetOpen}
            threadsShown={hasThreads}
            titleMenu={actions}
          />
        </ContextMenuTrigger>
        {actions.menu}
      </ContextMenu>
      {actions.dialogs}
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
          {threads.omittedCount > 0 ? (
            <ConversationSidebarThreadsOmitted count={threads.omittedCount} />
          ) : null}
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

type TitleMenu = Pick<
  ReturnType<typeof useInboxRowActions>,
  "menu" | "onMenuOpenChange"
>;

/** The line that holds a row's title link, and an open row's menu. */
function RowTitle(props: {
  children: ReactNode;
  expanded: boolean;
  menu?: TitleMenu | undefined;
}) {
  const className = "flex min-w-0 items-center gap-1.5";
  if (!props.menu) return <span className={className}>{props.children}</span>;
  // A closed row's own menu takes the right-click, so this one waits.
  return (
    <ContextMenu
      disabled={!props.expanded}
      onOpenChange={props.menu.onMenuOpenChange}
    >
      <ContextMenuTrigger className={className} render={<span />}>
        {props.children}
      </ContextMenuTrigger>
      {props.menu.menu}
    </ContextMenu>
  );
}

function InboxRowBody(
  props: InboxRowProps & {
    /** The row's own actions, shown in the meta's place on hover. */
    hoverActions?: ReactNode;
    /**
     * On a phone, whether the row is open, which shows its asks in a sheet.
     * Undefined where rows open in place.
     */
    sheetOpen: boolean | undefined;
    /** Whether the row lists its Threads under the head. */
    threadsShown?: boolean;
    /** The Conversation menu that an open row's title opens. */
    titleMenu?: TitleMenu;
  },
) {
  const { bundle, conversation } = props;
  // A row that names its Conversation opens it. A row for one item names
  // the item, and expands to show its answer controls.
  const opens = !props.itemTitle;
  const { path } = rowOpenTarget(props);
  const openPath = useOpenPath(path);
  const openConversation = (event: MouseEvent) => {
    props.onOpen?.();
    openPath(event);
  };
  const [density] = useConversationDensity();
  const comfortable = density === "comfortable";
  const openItems =
    bundle?.items.filter((item) => item.status === "open") ?? [];
  // A row for one item shows the live size of the code change it is about.
  const itemSize = useCodeChangeFacts(
    props.itemTitle ? bundle?.newest.subject : undefined,
  );
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
  // An open Conversation row's cards each say why their item woke.
  const wake = props.expanded && !props.itemTitle ? undefined : props.wake;
  // A closed row fits its title and subtitle to one line each. An open one
  // shows them in full, so its detail never needs to say them again.
  const lineClass = props.expanded ? "min-w-0 break-words" : fadeOverflowClass;
  // An item row's one card carries the row's actions on its own line.
  const inlineActions = Boolean(props.itemTitle) && openItems.length === 1;
  // A reply notice's card has nothing to answer, so its link to the reply is
  // its main action.
  const replyNotice = inlineActions && openItems[0]?.subject.kind === "reply";
  // A sheet keeps its asks through its closing motion.
  const asksShown =
    (props.expanded || props.sheetOpen !== undefined) &&
    (openItems.length > 0 || !props.actionsBelow);
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
  const space = conversation?.space;
  const cast =
    comfortable && conversation ? (
      // The Threads list below counts the Threads, so the cast doesn't.
      <ConversationCast
        agents={!props.threadsShown}
        conversation={conversation}
      />
    ) : null;
  // A click on the row does what the head link does, except on the pills,
  // summary chips and images in it.
  const rowClick = openOnClick(
    openConversation,
    opens ? undefined : props.onToggle,
  );
  const asksRegion = asksShown ? (
    <div
      aria-label={`${props.title}: asks`}
      className={cn(
        "grid min-w-0 gap-3",
        // In a sheet, the sheet's title names the row. In place, an item
        // row's detail starts on its title's left edge, with no rule: the
        // head and the detail are one card.
        props.sheetOpen !== undefined
          ? "p-4"
          : inlineActions
            ? "pr-4 pb-4 pl-8"
            : "border-t border-dashboard-border px-3 pt-3 pb-3",
      )}
      data-inbox-sheet={
        props.sheetOpen === undefined ? undefined : props.rowKey
      }
      data-sheet-open={props.sheetOpen || undefined}
      id={props.actionsBelow ? `${regionId}-asks` : regionId}
      role="region"
    >
      {openItems.map((item) => (
        <InboxRowCard
          actions={props.cardActions?.(item)}
          headTitled={Boolean(props.itemTitle)}
          item={item}
          key={item.id}
          notices={props.foldedNotices?.get(item.id) ?? NO_NOTICES}
          onAction={props.onItemAction}
          primaryAction={
            props.itemHead ? (
              <CodeChangeOpenButton
                head={props.itemHead}
                secondary={itemKindActions(item).length > 0}
              />
            ) : replyNotice ? (
              <ReplyNoticeLink item={item} open={rowOpenTarget(props)} />
            ) : undefined
          }
          rowActions={
            inlineActions
              ? rowActions(props, { inline: true, owner: !replyNotice })
              : undefined
          }
          take={props.take}
          wake={item.wake}
        />
      ))}
      {props.actionsBelow || inlineActions ? null : rowActions(props)}
    </div>
  ) : null;
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
              // Centered on the title's first line (`leading-snug`, 1.375rem).
              "col-start-1 row-start-1 mt-[0.4375rem] size-2 justify-self-center rounded-full",
              waiting
                ? "bg-dashboard-text"
                : openItems.length > 0
                  ? "border border-dashboard-text-faint"
                  : "",
            )}
            data-inbox-slot="dot"
            role={waiting || openItems.length > 0 ? "img" : undefined}
          />
          {/* The title slot spans the meta's column too. The title stays
              left of the meta, and the lines under it use the full width. */}
          <span
            className="col-span-2 col-start-2 row-start-1 grid min-w-0 grid-cols-subgrid gap-y-1"
            data-inbox-slot="title"
          >
            <RowTitle expanded={props.expanded} menu={props.titleMenu}>
              <Link
                aria-controls={opens ? undefined : controls}
                aria-current={props.selected ? "page" : undefined}
                aria-expanded={opens ? undefined : props.expanded}
                className={cn(
                  "grid min-w-0 flex-1 gap-1 rounded-md font-sans text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
                  // A long press opens the row menu, not the iOS link
                  // callout.
                  "[-webkit-touch-callout:none]",
                )}
                data-inbox-head=""
                data-row-menu=""
                // A middle click opens the link in a new tab.
                onAuxClick={(event) => {
                  if (event.button === 1) props.onOpen?.();
                }}
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
                  ) {
                    props.onOpen?.();
                    return;
                  }
                  event.preventDefault();
                  props.onToggle();
                }}
                to={path}
              >
                {props.itemHead && bundle ? (
                  <>
                    <CodeChangeTitle
                      expanded={props.expanded}
                      head={props.itemHead}
                    />
                    <CodeChangeSubtitle
                      expanded={props.expanded}
                      head={props.itemHead}
                      size={itemSize}
                      subtitle={props.itemSubtitle}
                    />
                  </>
                ) : (
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
                      <ChangeSize size={itemSize} />
                    </span>
                  </span>
                )}
                {props.itemTitle && props.itemSubtitle && !props.itemHead ? (
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
            </RowTitle>
            {wake ? (
              <span
                className={cn(
                  lineClass,
                  "col-span-2 text-xs text-dashboard-text-muted",
                )}
                data-inbox-slot="wake"
                ref={fadeWhenOverflowing}
              >
                {wakeReasonText(wake)}
              </span>
            ) : null}
            {/* Who is in it and what it asks, in one small line under the
                title. */}
            {space || cast || hasChips ? (
              // No wrap: the pills and the linked work fit to one shared
              // line, and wrapping would let each one's fit move the other.
              <span className="col-span-2 flex min-w-0 items-center gap-2">
                {space ? (
                  <SpaceChip className="shrink-0" space={space} />
                ) : null}
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
                  // A touch screen has no hover, and on a phone the actions
                  // crowd out the title. There a closed row hides them: a
                  // tap opens the row, and a long press opens its menu.
                  !props.expanded && "max-sm:hidden pointer-coarse:hidden",
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
            {images && props.conversationId ? (
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
            {files.length > 0 && props.conversationId ? (
              <InboxFiles conversationId={props.conversationId} files={files} />
            ) : null}
          </div>
        ) : null}
      </div>
      {props.sheetOpen === undefined ? (
        asksRegion
      ) : (
        <ToggleSheet
          label={props.itemTitle ?? props.title}
          onDismiss={props.onToggle}
          open={props.sheetOpen}
          size="content"
        >
          {asksRegion}
        </ToggleSheet>
      )}
    </>
  );
}

/**
 * The open row's actions. `inline` gives them bare, for a card's line.
 * `owner: false` leaves out the owner's link, for a card that has it as its
 * main action.
 */
function rowActions(
  props: InboxRowProps,
  { inline = false, owner = true }: { inline?: boolean; owner?: boolean } = {},
) {
  return (
    <ExpandedActions
      conversation={props.conversation}
      inline={inline}
      // Next to a code change card's main action: as tall as it.
      look={inline && props.itemHead ? "tall" : undefined}
      // A stack of one card snoozes on the card.
      {...((props.bundle?.items.length ?? 0) > 1
        ? { eventSnooze: props.eventSnooze, onSnooze: props.onSnooze }
        : undefined)}
      onSnoozeMenu={props.onSnoozeMenu}
      onWake={props.onWake}
      // A viewer who cannot see the Conversation gets no link to it.
      open={
        owner && !(props.bundle && itemConversationHidden(props.bundle.newest))
          ? rowOpenTarget(props)
          : undefined
      }
      snoozeMenuOpen={props.snoozeMenuOpen}
    />
  );
}

function ExpandedActions(props: {
  conversation?: Conversation;
  inline: boolean;
  eventSnooze?: EventSnooze | undefined;
  look?: ButtonLook | undefined;
  open: RowOpenTarget | undefined;
  onSnooze?(untilMs: number): void;
  onSnoozeMenu(open: boolean): void;
  onWake?(): void;
  snoozeMenuOpen: boolean;
}) {
  // The owner's link goes last, next to a card's main action.
  const actions = (
    <>
      {props.onSnooze ? (
        <RowSnoozeButton
          eventSnooze={props.eventSnooze}
          label="Snooze all"
          onOpenChange={props.onSnoozeMenu}
          onSnooze={props.onSnooze}
          open={props.snoozeMenuOpen}
        />
      ) : null}
      {props.onWake ? (
        <Button
          className={props.look && LOOK_CLASSES[props.look]}
          onClick={props.onWake}
          variant="ghost"
        >
          <AlarmClockOff aria-hidden="true" size={15} />
          <ButtonLabel look={props.look}>Wake</ButtonLabel>
        </Button>
      ) : null}
      {props.conversation?.isParticipant ? (
        <ExpandedPin conversation={props.conversation} look={props.look} />
      ) : null}
      {props.open ? <RowOwnerLink look={props.look} open={props.open} /> : null}
    </>
  );
  if (props.inline) return actions;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {actions}
    </div>
  );
}
