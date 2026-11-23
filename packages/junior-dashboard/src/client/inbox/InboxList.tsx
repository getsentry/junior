import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { useDocumentTitle } from "../documentTitle";
import { InlineError } from "../components/InlineError";
import { MobileHeaderActionsPortal } from "../components/layout/DashboardChrome";
import { HeaderBar } from "../components/layout/HeaderBar";
import { PaneCollapsedControls } from "../components/layout/PaneNav";
import { Skeleton } from "../components/ui/skeleton";
import { MessageObjectsProvider } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";
import {
  useInboxData,
  type ConversationRow,
  type InboxFeedPages,
} from "./inboxData";
import { InboxDoneView } from "./InboxDoneView";
import {
  DOCK_GUTTER,
  InboxFocusProvider,
  InboxPreviewGate,
  useCollapseOutside,
  useInboxFocus,
} from "./inboxFocus";
import { codeChangeHead } from "./codeChangeHead";
import { heldRows, rowPlaces, type RowPlaces } from "./heldRows";
import {
  askTypeOf,
  hasListFilters,
  inConversationState,
  ListFilters,
  listFiltersOf,
  withoutFilters,
} from "./inboxFilters";
import { useInboxListState, useLinkedInboxItems } from "./inboxListState";
import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  childOf,
  itemRowSubtitle,
  linkedRowOf,
  singleRow,
  sweepOf,
  timeGroups,
  viewRows,
  viewSections,
} from "./inboxModel";
import { InboxRow } from "./InboxRow";
import type { SnoozeEnd } from "./inboxSnoozes";
import { PageEnd, RetryRow } from "./PageEnd";
import {
  inboxCardActions,
  inboxStackActions,
  useInboxRowActs,
} from "./inboxRowActs";
import { useLeaveCard, useLeaveRow } from "./rowMotion";
import { useLeaveClosedElsewhere } from "./inboxClosedElsewhere";
import { InboxEmptyState, InboxSection, SweepControl } from "./InboxSection";
import { InboxStack, STACK_ROW_KEYS, stackRows } from "./InboxStack";
import { eventSnoozeOf } from "./snoozeChoices";
import { useInboxItemData, useInboxItemsData } from "./queries";
import { scrollPages } from "./inboxQueries";
import {
  conversationAnswerLine,
  type InboxBundle,
  itemNeedsViewer,
  itemOwnerPath,
  itemUpForGrabs,
} from "./inboxItemFormat";

const TODO_COLLAPSED_KEY = "junior:inbox:todo-collapsed";

function RowsLoading() {
  return (
    <div aria-busy="true" className="grid gap-1 pt-2" role="status">
      <span className="sr-only">Loading</span>
      {[0, 1, 2, 3, 4].map((row) => (
        <div className="grid gap-1.5 py-2" key={row}>
          <Skeleton className={cn("h-4", row % 2 ? "w-2/5" : "w-3/5")} />
          <Skeleton className="h-3 w-4/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}

/**
 * The list of one Inbox sidebar entry, in the main area, like Google Inbox.
 * The Inbox leads with To do, the asks that wait on the viewer; it
 * collapses, and stays collapsed. Today, This week, and Earlier follow. A
 * click on a row opens its Conversation here; Back brings the list back as
 * it was. `?item=` expands the row that holds that item once.
 */
export function InboxList(props: {
  error?: string;
  loading: boolean;
  /** On a phone the list has its own page, under the entries. */
  phone?: boolean;
}) {
  const data = useInboxData();
  const ready = data.itemsLoaded && !props.loading;
  const state = useInboxListState(ready);
  const { view } = state;
  useDocumentTitle(INBOX_VIEW_LABELS[view]);
  const { nowMs, readSnoozed, snoozes, sweeper, titleOf } = data;
  const conversationOf = (id: string | undefined) =>
    id === undefined ? undefined : data.conversationById.get(id);
  useEffect(readSnoozed, [readSnoozed]);
  const done = useInboxItemsData({
    closed: true,
    enabled: data.signedIn && view === "done",
    forViewer: true,
  });
  const donePages = scrollPages(done.query);

  const [todoCollapsed, setTodoCollapsed] = useLocalStorage(
    TODO_COLLAPSED_KEY,
    false,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleSection = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [snoozeKey, setSnoozeKey] = useState<string>();
  const toggle = (key: string) => {
    setSnoozeKey(undefined);
    state.toggle(key);
  };
  const focus = useInboxFocus(state.scroller, state.expandedKey);
  useCollapseOutside(state.expandedKey, () => toggle(state.expandedKey));
  const leave = useLeaveRow(
    state.scroller,
    state.expandedKey,
    state.setExpandedKey,
  );
  const leaveCard = useLeaveCard(state.scroller, leave);
  const act = useInboxRowActs({
    holdLeaving: data.holdLeaving,
    leave,
    leaveCard,
    scroller: state.scroller,
    setExpandedKey: state.setExpandedKey,
  });

  // `?type=` shows the Inbox asks of one type, and `?pinned=1` only the
  // rows of the viewer's pins, in their places. The feed's first page holds
  // every pin, so Pinned reads no more of it. `?state=` shows the
  // Conversations in one viewer state.
  const [params] = useSearchParams();
  const { conversationState, pinnedOnly, type } = listFiltersOf(
    params,
    view,
    data.signedIn,
  );
  const inboxRows =
    pinnedOnly || type !== "all"
      ? data.rowsOf(
          (item) =>
            (type === "all" || askTypeOf(item) === type) &&
            (!pinnedOnly || data.isPinned(item.rootConversationId)),
        )
      : { fyi: data.fyiRows, grabs: data.grabRows, todo: data.todoRows };
  // While the pointer is on the list, a feed refresh moves no row under it.
  const [held, setHeld] = useState<RowPlaces>();
  // Only Conversations lists Conversations. The Inbox holds what needs the
  // viewer, and In flight in the pane holds what runs or is pinned.
  const latestStreamRows =
    view === "conversations"
      ? data.conversationRows.filter(
          (row) =>
            (!pinnedOnly || row.conversation?.pinnedAt) &&
            inConversationState(
              row.conversation,
              row.bundle?.needsYou ?? false,
              conversationState,
            ),
        )
      : [];
  const streamRows = heldRows(latestStreamRows, held);

  // `?item=` names one item, as old Inbox links and notifications do. Its
  // row expands, the list shows rows until it renders, and it scrolls into
  // view. Only then does the link leave the URL.
  const navigate = useNavigate();
  const linkedId = params.get("item") ?? undefined;
  // Done shows a linked closed item that is past its first page too. The
  // list state keeps it, so a tab switch or a remount keeps its row.
  const [linkedItems, setLinkedItems] = useLinkedInboxItems();
  const linkedClosed = useInboxItemData(linkedItems.closed).data;
  const doneItems =
    linkedClosed && !done.items.some((item) => item.id === linkedClosed.id)
      ? [linkedClosed, ...done.items]
      : done.items;
  const {
    key: linkedRowKey,
    open: linkedOpen,
    rowItemId,
    snoozedKey,
  } = linkedRowOf(view, linkedId, {
    awake: data.awake,
    done: doneItems,
    foldedNotices: data.foldedNotices,
    grabs: data.grabRows,
    snoozed: data.snoozedRows,
    todo: data.todoRows,
  });
  // A snoozed item is still open. Its link opens Snoozed, with its row.
  const linkedSnoozed = rowItemId ? data.snoozes.hidesItem(rowItemId) : false;
  const linkedLoaded =
    view === "done" ? Boolean(done.query.data) : ready && !linkedRowKey;
  // An item that is not in this list may be closed, or past its first page.
  const linked = useInboxItemData(
    linkedId && !linkedRowKey && linkedLoaded ? linkedId : undefined,
  );
  const { includedExtra, includedId, includeItem } = data;
  // In the Inbox, an ask that waits on someone else gets no row, so its
  // link does not replace the item that an earlier link kept. It still
  // joins a To do stack that another item keeps there. The kept item counts
  // only when a loaded page holds it too, since the link replaces it.
  const linkedGetsRow =
    !linked.data ||
    view !== "inbox" ||
    linked.data.kind === "notice" ||
    itemUpForGrabs(linked.data) ||
    itemNeedsViewer(linked.data) ||
    data.todoRows.some(
      (row) =>
        row.conversationId === linked.data?.rootConversationId &&
        row.items.some(
          (item) =>
            !(includedExtra && item.id === includedId) && itemNeedsViewer(item),
        ),
    );
  // Stream rows show a page at a time, so a linked row can be past them.
  const linkedStreamIndex =
    linkedOpen && linkedRowKey?.startsWith("conversation:")
      ? streamRows.findIndex(
          (row) => row.conversationId === linkedOpen.rootConversationId,
        )
      : -1;
  const { expandedKey, listPath, loaded, setExpandedKey, showMore } = state;
  useEffect(() => {
    if (!linkedId) return;
    // The router moves the URL as soon as the reader leaves, before this
    // list renders again. A link must not replace the place they picked.
    const current = new URLSearchParams(window.location.search).get("item");
    if (current !== linkedId) return;
    if (linkedRowKey) {
      // A collapsed To do or FYI has no rows, so a link into it opens it
      // first.
      if (linkedRowKey.startsWith("todo:") && todoCollapsed) {
        setTodoCollapsed(false);
        return;
      }
      if (linkedRowKey.startsWith("fyi:") && collapsed.has("fyi")) {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete("fyi");
          return next;
        });
        return;
      }
      if (expandedKey !== linkedRowKey) {
        setExpandedKey(linkedRowKey);
        return;
      }
      // The skeleton has no rows yet.
      if (!ready) return;
      if (linkedStreamIndex >= loaded) {
        showMore();
        return;
      }
      // The link leaves the URL only once its row is on screen. Until the
      // row renders, a later render runs this again.
      const row = document.querySelector(
        `[data-inbox-row="${CSS.escape(linkedRowKey)}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      void navigate(withoutFilters(listPath), { replace: true });
      return;
    }
    if (snoozedKey || linkedSnoozed) {
      if (view !== "snoozed") {
        void navigate(inboxViewPath("snoozed", { itemId: linkedId }), {
          replace: true,
        });
      } else if (data.snoozedRead.settled) {
        // Snoozed read every page without the row, so the link is stale.
        void navigate(listPath, { replace: true });
      }
      return;
    }
    if (!linkedLoaded) return;
    if (linked.error) {
      void navigate(listPath, { replace: true });
      return;
    }
    if (!linked.data) return;
    if (linked.data.status === "open") {
      // Until Snoozed loads, an open item may still be snoozed. If it
      // cannot load, the link cannot tell, so it opens no row.
      if (linkedSnoozed === undefined) {
        if (data.snoozes.failed) void navigate(listPath, { replace: true });
        return;
      }
      // Past the loaded page, it joins the list, and its row expands on the
      // next render. Snoozed or swept, it has no row to expand.
      if (linkedGetsRow && includedId !== linkedId) includeItem(linkedId);
      else void navigate(listPath, { replace: true });
    } else if (view === "done") {
      const closedId = linked.data.id;
      setLinkedItems((current) => ({ ...current, closed: closedId }));
    } else {
      void navigate(inboxViewPath("done", { itemId: linkedId }), {
        replace: true,
      });
    }
  }, [
    collapsed,
    expandedKey,
    includeItem,
    includedId,
    linked.data,
    linked.error,
    linkedGetsRow,
    linkedId,
    linkedLoaded,
    linkedRowKey,
    linkedSnoozed,
    data.snoozes.failed,
    data.snoozedRead.settled,
    linkedStreamIndex,
    listPath,
    loaded,
    navigate,
    ready,
    setExpandedKey,
    setLinkedItems,
    setTodoCollapsed,
    showMore,
    snoozedKey,
    todoCollapsed,
    view,
  ]);

  const sweepControl = (rows: readonly InboxBundle[], scope: string) => (
    <SweepControl
      clear={sweepOf(rows, data.isPinned).length}
      onSweep={() => sweeper.sweep(sweepOf(rows, data.isPinned))}
      scope={scope}
    />
  );
  // Each card of a stack answers, dismisses, and snoozes by itself.
  const cardActions = inboxCardActions({
    act,
    leave,
    leaveCard,
    setSnoozeKey,
    snoozeItem: (item, end) => void snoozes.snoozeItem(item, end),
    snoozeKey,
  });

  // The items of each row that this render shows, by row key.
  const rowItems = new Map<string, readonly InboxItemPayload[]>();
  const bundleRow = (
    row: InboxBundle,
    options: {
      answered?: string;
      conversation?: Conversation;
      itemRow?: boolean;
      key?: string;
      /** Rows that leave with this one, as its stack in To do. */
      passing?: ReadonlySet<string>;
      /** The row is one item of a stack, under its title. */
      stacked?: boolean;
      /** The row sits under a card that already names its subject. */
      subjectShown?: boolean;
      /** A snoozed row wakes instead of snoozing. */
      snoozed?: boolean;
      take?: string;
      /** The row is in To do. */
      todo?: boolean;
      time?: string;
    } = {},
  ) => {
    const key = options.key ?? row.key;
    rowItems.set(key, row.items);
    const title = titleOf(row.conversationId) ?? row.newest.title;
    const acted = { items: row.items, key, passing: options.passing, title };
    const head = options.itemRow
      ? codeChangeHead(row.newest, conversationOf(row.conversationId))
      : undefined;
    const expanded = state.expandedKey === key;
    // An opened item stops saying why it woke once its row closes.
    const wake = row.items.find(
      (item) =>
        item.status === "open" &&
        (expanded || !snoozes.wakeOpened(item)) &&
        item.wake,
    )?.wake;
    const snoozeRow = options.snoozed
      ? undefined
      : (end: SnoozeEnd) => {
          setSnoozeKey(undefined);
          // The snooze hides the row before it saves, and brings it back
          // with a toast when the save fails.
          leave(key, () => void snoozes.snooze(row, end));
        };
    return (
      <InboxRow
        answered={options.answered}
        bundle={row}
        cardActions={cardActions(acted, options)}
        // Conversations rows keep their Pin and Archive.
        itemActions={view !== "conversations"}
        conversation={
          // An item row is one item, with no Conversation actions. A
          // stack's title names its Conversation.
          options.stacked || options.itemRow
            ? undefined
            : (options.conversation ?? conversationOf(row.conversationId))
        }
        conversationId={row.conversationId}
        expanded={expanded}
        foldedNotices={data.foldedNotices}
        itemHead={head}
        itemTitle={options.itemRow ? row.newest.title : undefined}
        itemSubtitle={
          options.itemRow
            ? itemRowSubtitle(
                // The code change head shows the subject's title.
                options.subjectShown || head
                  ? { ...row.newest, subject: undefined }
                  : row.newest,
                // A child's item names its sub-thread: under the stack's
                // title, or after its root's title on its own.
                options.stacked
                  ? row.newest.addedByLabel
                  : childOf(titleOf(row.conversationId), row.newest),
              )
            : undefined
        }
        key={key}
        onItemAction={(item, body) => act(acted, [item], body)}
        eventSnooze={eventSnoozeOf(row.items, snoozeRow)}
        onSnooze={snoozeRow}
        onWake={
          options.snoozed
            ? () =>
                leave(
                  key,
                  () =>
                    void (options.stacked || options.itemRow
                      ? snoozes.wakeItem(row.newest)
                      : snoozes.wake(row)),
                )
            : undefined
        }
        onOpen={() => snoozes.openWoken(row.items)}
        onSnoozeMenu={(open) => setSnoozeKey(open ? key : undefined)}
        onToggle={() => {
          if (!expanded) snoozes.openWoken(row.items);
          toggle(key);
        }}
        rowKey={key}
        selected={false}
        showThreads={!options.itemRow}
        snoozeMenuOpen={snoozeKey === key}
        take={options.take}
        time={options.time ?? row.waitingSince}
        title={title}
        wake={wake}
      />
    );
  };
  // Each item shows its own row. A root Conversation with more than one
  // item shows them as a stack, under the root's title.
  // A section counts its item rows, not its stacks.
  const rowCount = (
    bundles: readonly InboxBundle[],
    keyOf: (id: string) => string,
    todo?: boolean,
  ) =>
    bundles.reduce(
      (sum, bundle) => sum + stackRows(bundle, keyOf, todo).length,
      0,
    );
  const stackRow = (
    row: InboxBundle,
    keyOf: (id: string) => string,
    options: {
      conversation?: Conversation;
      snoozed?: boolean;
      take?: string;
      time?: string;
      todo?: boolean;
    } = {},
  ) => {
    const stackKey = keyOf(row.key);
    // Built here, so the list knows each row's items as it renders.
    const rows = stackRows(row, keyOf, options.todo);
    // A lone item shows its own row: an item row is always one actionable
    // item.
    if (rows.length === 1)
      return bundleRow(row, {
        ...options,
        itemRow: true,
        key: rows[0]!.key,
        passing: rows[0]!.passing,
      });
    const title = titleOf(row.conversationId) ?? row.newest.title;
    return (
      <InboxStack
        conversation={conversationOf(row.conversationId)}
        expandedKey={state.expandedKey}
        key={stackKey}
        keys={rows.map((stacked) => stacked.key)}
        stackKey={stackKey}
        {...inboxStackActions({
          act,
          expandedKey: state.expandedKey,
          items: row.items,
          keys: rows.map((stacked) => stacked.key),
          stackKey,
          title,
          snooze: (end) => {
            setSnoozeKey(undefined);
            leave(stackKey, () => void snoozes.snooze(row, end));
          },
          snoozed: options.snoozed,
        })}
        onOpen={() => snoozes.openWoken(row.items)}
        onSnoozeMenu={(open) => setSnoozeKey(open ? stackKey : undefined)}
        path={
          row.conversationId
            ? conversationPath(row.conversationId)
            : itemOwnerPath(row.newest)
        }
        snoozeMenuOpen={snoozeKey === stackKey}
        title={title}
      >
        {rows.map(({ item, key, passing }) =>
          bundleRow(singleRow(item), {
            ...options,
            itemRow: true,
            key,
            passing,
            stacked: true,
            time: item.createdAt,
          }),
        )}
      </InboxStack>
    );
  };
  const conversationRow = (row: ConversationRow) => {
    const key = `conversation:${row.conversationId}`;
    const answered = row.conversation
      ? conversationAnswerLine(row.conversation)
      : undefined;
    if (row.bundle)
      return bundleRow(row.bundle, {
        answered,
        conversation: row.conversation,
        key,
        time: row.time,
      });
    return (
      <InboxRow
        answered={answered}
        conversation={row.conversation}
        conversationId={row.conversationId}
        expanded={state.expandedKey === key}
        key={key}
        onSnoozeMenu={() => undefined}
        onToggle={() => toggle(key)}
        rowKey={key}
        selected={false}
        showThreads
        snoozeMenuOpen={false}
        time={row.time}
        title={row.conversation?.displayTitle ?? "Conversation"}
      />
    );
  };
  // Infinite scroll: stream rows render a page at a time as the end comes
  // into view. When every loaded row shows, the next page of what the list
  // reads loads: the feed, the open asks, or Done.
  const hidden = Math.max(0, streamRows.length - state.loaded);
  const pages: InboxFeedPages[] =
    view === "inbox"
      ? [data.itemPages]
      : view === "conversations"
        ? pinnedOnly
          ? []
          : [data.feed]
        : view === "decisions"
          ? [data.itemPages]
          : view === "done"
            ? [donePages]
            : [];
  // To do pages its asks on its own until the server has no more, and shows
  // its own Try again, so the stream does not repeat it.
  const todoMore = data.signedIn && data.itemPages.hasMore;
  const todoPaging = view === "inbox" && todoMore && !todoCollapsed;
  // A failed page read stops only new reads. Rows already loaded still
  // show as the reader scrolls, and Try again shows once they all do.
  const failed =
    hidden > 0
      ? []
      : pages.filter(
          (source) =>
            source.failed && !(todoPaging && source === data.itemPages),
        );
  const more =
    hidden > 0 ||
    (failed.length === 0 && pages.some((source) => source.hasMore));
  const loadingMore = pages.some((source) => source.loadingMore);
  // The trigger asks again whenever rows arrive or show.
  const progress = [
    view,
    state.loaded,
    streamRows.length,
    data.awake.length,
    doneItems.length,
    ...pages.map((source) => source.loadingMore),
  ].join();
  const listEnd = ready ? (
    <PageEnd
      failed={failed.length > 0}
      loading={hidden > 0 || loadingMore}
      more={more}
      onRetry={() => {
        for (const source of failed) source.retry();
      }}
      onShow={() => {
        if (hidden > 0) state.showMore();
        else for (const source of pages) source.loadMore();
      }}
      progress={progress}
    />
  ) : null;
  const todoEnd = (
    <PageEnd
      failed={data.itemPages.failed && todoMore}
      loading={data.itemPages.loadingMore}
      more={todoMore}
      onRetry={data.itemPages.retry}
      onShow={data.itemPages.loadMore}
      progress={[data.awake.length, data.itemPages.loadingMore].join()}
    />
  );

  const stream = () =>
    timeGroups(streamRows.slice(0, state.loaded), (row) => row.time, nowMs).map(
      (section) => (
        <InboxSection
          action={sweepControl(
            section.rows.flatMap((row) => (row.bundle ? [row.bundle] : [])),
            section.label,
          )}
          collapsed={collapsed.has(section.key)}
          count={section.rows.length}
          key={section.key}
          label={section.label}
          onToggle={() => toggleSection(section.key)}
        >
          {section.rows.map((row) => conversationRow(row))}
        </InboxSection>
      ),
    );

  let body;
  if (data.itemsError) {
    body = (
      <InlineError className="py-3">Could not load your asks.</InlineError>
    );
  } else if (!ready) {
    body = <RowsLoading />;
  } else if (pinnedOnly && data.pinned.length === 0) {
    body = (
      <InboxEmptyState label="Nothing pinned. Pin a conversation from its row or its menu." />
    );
  } else if (view === "inbox") {
    const nothingLeft =
      !todoMore &&
      inboxRows.todo.length + inboxRows.grabs.length + inboxRows.fyi.length ===
        0;
    // A type's count adds the asks past the loaded pages, as All's does.
    // Pinned counts the rows that it shows.
    const todoCount = pinnedOnly
      ? rowCount(inboxRows.todo, STACK_ROW_KEYS.todo, true)
      : data.todoCounts[type];
    body = (
      <>
        {data.signedIn ? (
          <InboxSection
            action={sweepControl(inboxRows.todo, "To do")}
            badge={
              todoCount ? (
                <span className="text-xs font-medium tabular-nums text-dashboard-text-muted">
                  {todoCount}
                </span>
              ) : null
            }
            collapsed={todoCollapsed}
            footer={todoEnd}
            // The rows show without the server count, which may still load
            // or have failed.
            count={
              todoCount || rowCount(inboxRows.todo, STACK_ROW_KEYS.todo, true)
            }
            label="To do"
            onToggle={() => setTodoCollapsed(!todoCollapsed)}
          >
            {inboxRows.todo.map((row) =>
              stackRow(row, STACK_ROW_KEYS.todo, { todo: true }),
            )}
          </InboxSection>
        ) : null}
        <InboxSection
          collapsed={collapsed.has("grabs")}
          count={rowCount(inboxRows.grabs, STACK_ROW_KEYS.grabs)}
          label="Up for grabs"
          onToggle={() => toggleSection("grabs")}
        >
          {inboxRows.grabs.map((row) =>
            stackRow(row, STACK_ROW_KEYS.grabs, { take: "I'll take it" }),
          )}
        </InboxSection>
        {/* Notices wait on no one: quiet rows, stacked, after the asks. */}
        <InboxSection
          action={sweepControl(inboxRows.fyi, "FYI")}
          collapsed={collapsed.has("fyi")}
          count={rowCount(inboxRows.fyi, STACK_ROW_KEYS.fyi)}
          label="FYI"
          onToggle={() => toggleSection("fyi")}
        >
          {inboxRows.fyi.map((row) => stackRow(row, STACK_ROW_KEYS.fyi, {}))}
        </InboxSection>
        {nothingLeft ? <InboxEmptyState label="Nothing left here" /> : null}
      </>
    );
  } else if (view === "conversations") {
    // A state filter can match rows on pages not read yet, so the list
    // keeps paging before it says that none match. Pinned reads no pages.
    body =
      streamRows.length === 0 &&
      !(conversationState !== "all" && !pinnedOnly && data.feed.hasMore) ? (
        <InboxEmptyState
          label={
            conversationState === "all" && !pinnedOnly
              ? "No conversations yet"
              : "No conversations match these filters"
          }
        />
      ) : (
        stream()
      );
  } else if (view === "done") {
    // A failed first read has no rows to page, so it shows its own retry.
    body =
      done.query.isError && !done.query.data ? (
        <RetryRow
          loading={done.query.isFetching}
          onRetry={() => void done.query.refetch()}
        >
          Could not load Done.
        </RetryRow>
      ) : !done.query.data ? (
        <RowsLoading />
      ) : doneItems.length === 0 ? (
        <InboxEmptyState label="Nothing done yet" />
      ) : (
        <InboxDoneView
          collapsed={collapsed}
          expandedKey={state.expandedKey}
          items={doneItems}
          nowMs={nowMs}
          onToggle={toggle}
          onToggleSection={toggleSection}
          titleOf={titleOf}
        />
      );
  } else if (view === "snoozed") {
    // A failed read keeps the rows already read, with a retry below them.
    const snoozedRetry = data.snoozedRead.failed ? (
      <RetryRow
        loading={data.snoozedRead.loading}
        onRetry={data.snoozedRead.retry}
      >
        Could not load your snoozed rows.
      </RetryRow>
    ) : null;
    body =
      data.snoozedRows.length > 0 ? (
        <>
          {/* Snoozed rows expand in place like the others, and wake there. */}
          <ul className="m-0 grid gap-2 p-0 pt-1" data-dock-list="">
            {data.snoozedRows.map((row) =>
              stackRow(row, STACK_ROW_KEYS.snoozed, { snoozed: true }),
            )}
          </ul>
          {snoozedRetry}
        </>
      ) : (
        (snoozedRetry ??
        (data.snoozedRead.loaded ? (
          <InboxEmptyState label="Nothing snoozed" />
        ) : (
          <RowsLoading />
        )))
      );
  } else {
    const sections = viewSections(viewRows(data.awake, view), titleOf);
    body =
      sections.length === 0 ? (
        <InboxEmptyState label="Nothing left here" />
      ) : (
        sections.map((section) => (
          <InboxSection
            action={sweepControl(section.rows, section.label)}
            collapsed={collapsed.has(section.key)}
            count={section.rows.length}
            key={section.key}
            label={section.label}
            onToggle={() => toggleSection(section.key)}
          >
            {section.rows.map((row) => bundleRow(row, { itemRow: true }))}
          </InboxSection>
        ))
      );
  }

  useLeaveClosedElsewhere({
    closedElsewhere: data.closedElsewhere,
    expandedKey,
    holdLeaving: data.holdLeaving,
    holdOpenRow: data.holdOpenRow,
    leave,
    leaveCard,
    openItems: rowItems.get(expandedKey) ?? [],
    releaseHeld: data.releaseHeld,
  });

  // The Inbox has no heading; a bundle shows only its name.
  const heading = view === "inbox" ? undefined : INBOX_VIEW_LABELS[view];
  const headerBar = Boolean(heading && !props.phone);
  const filters = hasListFilters(view, data.signedIn) ? (
    <ListFilters
      conversationState={conversationState}
      counts={data.todoCounts}
      pinnedOnly={pinnedOnly}
      search={params.toString()}
      signedIn={data.signedIn}
      type={type}
      view={view}
    />
  ) : null;
  // The filters sit in the top row: the phone header, or the desktop header
  // of a list with a heading. The Inbox on a desktop has no heading, so its
  // filters sit above the rows.
  const filterBar = props.phone || headerBar ? null : filters;
  // One request resolves the code changes of every item row.
  return (
    <MessageObjectsProvider>
      <section
        aria-label={INBOX_VIEW_LABELS[view]}
        className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg"
      >
        {props.phone && filters ? (
          <MobileHeaderActionsPortal>
            <div className="flex items-center gap-1">{filters}</div>
          </MobileHeaderActionsPortal>
        ) : null}
        {headerBar ? (
          <HeaderBar actions={filters} title={heading} />
        ) : (
          <div className="absolute top-2 left-3 z-10 max-md:hidden">
            <PaneCollapsedControls />
          </div>
        )}
        <div
          className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
          data-inbox-scroll=""
          onScroll={state.onScroll}
          ref={state.scroller}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setHeld(rowPlaces(streamRows));
          }}
          onPointerLeave={() => {
            setHeld(undefined);
            focus.handlers.onPointerLeave();
          }}
          onPointerMove={focus.handlers.onPointerMove}
        >
          <div
            className={cn(
              "mx-auto w-full max-w-6xl pb-16",
              props.phone ? "px-2 pt-1" : "pt-3",
            )}
            // The dock grows cards near the pointer; this inset keeps them off
            // the scroll area's edge.
            style={props.phone ? undefined : { paddingInline: DOCK_GUTTER }}
          >
            {filterBar ? (
              // One right-aligned row, clear of the pane controls that float
              // at the top left while the pane is collapsed.
              <div className="flex items-center justify-end gap-2 pb-2">
                {filterBar}
              </div>
            ) : null}
            <InboxFocusProvider focus={focus.focus}>
              <InboxPreviewGate>{body}</InboxPreviewGate>
            </InboxFocusProvider>
            {data.itemsError ? null : listEnd}
            {props.error ? (
              <InlineError className="py-2">{props.error}</InlineError>
            ) : null}
          </div>
        </div>
      </section>
    </MessageObjectsProvider>
  );
}
