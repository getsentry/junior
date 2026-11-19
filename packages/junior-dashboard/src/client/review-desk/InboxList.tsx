import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import type {
  AutomationListItem,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { useDocumentTitle } from "../documentTitle";
import { InlineError } from "../components/InlineError";
import { HeaderBar } from "../components/layout/HeaderBar";
import { PaneCollapsedControls } from "../components/layout/PaneNav";
import { Skeleton } from "../components/ui/skeleton";
import { useConversationActionToasts } from "../conversations/conversationActionToasts";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
  type PinnedRowDrag,
} from "../conversations/PinnedConversationOrder";
import { useReorderPinnedConversations } from "../conversations/useReorderPinnedConversations";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { InboxAutomationRow } from "./InboxAutomationRow";
import {
  useInboxData,
  type ConversationRow,
  type InboxFeedPages,
} from "./inboxData";
import { InboxDoneView } from "./InboxDoneView";
import { PullRequestChange, usePullRequestSections } from "./InboxPullRequests";
import {
  DOCK_GUTTER,
  InboxFocusProvider,
  InboxPreviewGate,
  useCollapseOutside,
  useInboxFocus,
} from "./inboxFocus";
import { heldRows, rowPlaces, type RowPlaces } from "./heldRows";
import { useInboxListState, useLinkedInboxItems } from "./inboxListState";
import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  itemRowSubtitle,
  linkedRowOf,
  singleRow,
  sweepOf,
  timeGroups,
  viewRows,
  viewSections,
} from "./inboxModel";
import { InboxRow } from "./InboxRow";
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
import { useReviewItemData, useReviewItemsData } from "./queries";
import { scrollPages } from "./inboxQueries";
import {
  conversationAnswerLine,
  itemNeedsViewer,
  itemUpForGrabs,
  type InboxBundle,
} from "./reviewItemFormat";

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

/** A pinned row of the Conversations bundle, which drags into a new order. */
function DraggableRow(props: {
  conversationId: string;
  render(drag: PinnedRowDrag | undefined): ReactNode;
}) {
  return props.render(usePinnedRowDrag(props.conversationId));
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
  const { nowMs, snoozes, sweeper, titleOf } = data;
  const done = useReviewItemsData({
    closed: true,
    enabled: data.signedIn && view === "done",
    forViewer: true,
  });
  const donePages = scrollPages(done.query);
  const reorderPins = useReorderPinnedConversations();
  const { showActionError } = useConversationActionToasts();

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

  const pullRequests = usePullRequestSections(
    viewRows(data.awake, "prs"),
    data.itemPages,
    view === "prs",
  );
  // While the pointer is on the list, a feed refresh moves no row under it.
  const [held, setHeld] = useState<RowPlaces>();
  // Only Conversations lists Conversations. The Inbox holds what needs the
  // viewer, and In flight in the pane holds what runs or is pinned.
  const latestStreamRows =
    view === "conversations" ? data.conversationRows : [];
  const streamRows = heldRows(latestStreamRows, held);

  // `?item=` names one item, as old Inbox links and notifications do. Its
  // row expands, the list shows rows until it renders, and it scrolls into
  // view. Only then does the link leave the URL.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const linkedId = params.get("item") ?? undefined;
  // Done shows a linked closed item that is past its first page too. The
  // list state keeps it, so a tab switch or a remount keeps its row.
  const [linkedItems, setLinkedItems] = useLinkedInboxItems();
  const linkedClosed = useReviewItemData(linkedItems.closed).data;
  const doneItems =
    linkedClosed && !done.items.some((item) => item.id === linkedClosed.id)
      ? [linkedClosed, ...done.items]
      : done.items;
  const {
    key: linkedRowKey,
    open: linkedOpen,
    snoozedKey,
  } = linkedRowOf(view, linkedId, {
    awake: data.awake,
    done: doneItems,
    foldedNotices: data.foldedNotices,
    grabs: data.grabRows,
    snoozed: data.snoozedRows,
    todo: data.todoRows,
  });
  const linkedLoaded =
    view === "done" ? Boolean(done.query.data) : ready && !linkedRowKey;
  // An item that is not in this list may be closed, or past its first page.
  const linked = useReviewItemData(
    linkedId && !linkedRowKey && linkedLoaded ? linkedId : undefined,
  );
  // In the Inbox, an ask that waits on someone else gets no row, so its
  // link does not replace the item that an earlier link kept.
  const linkedGetsRow =
    !linked.data ||
    view !== "inbox" ||
    linked.data.kind === "notice" ||
    itemUpForGrabs(linked.data) ||
    itemNeedsViewer(linked.data) ||
    data.todoRows.some(
      (row) => row.conversationId === linked.data?.rootConversationId,
    );
  // Stream rows show a page at a time, so a linked row can be past them.
  const linkedStreamIndex =
    linkedOpen && linkedRowKey?.startsWith("conversation:")
      ? streamRows.findIndex(
          (row) => row.conversationId === linkedOpen.rootConversationId,
        )
      : -1;
  const { expandedKey, listPath, loaded, setExpandedKey, showMore } = state;
  const { includedId, includeItem } = data;
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
      void navigate(listPath, { replace: true });
      return;
    }
    if (snoozedKey) {
      void navigate(inboxViewPath("snoozed", { itemId: linkedId }), {
        replace: true,
      });
      return;
    }
    if (!linkedLoaded) return;
    if (linked.error) {
      void navigate(listPath, { replace: true });
      return;
    }
    if (!linked.data) return;
    if (linked.data.status === "open") {
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
    snoozeItem: snoozes.snoozeItem,
    snoozeKey,
  });

  // The items of each row that this render shows, by row key.
  const rowItems = new Map<string, readonly ReviewItemPayload[]>();
  const bundleRow = (
    row: InboxBundle,
    options: {
      answered?: string;
      conversation?: Conversation;
      drag?: PinnedRowDrag;
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
    return (
      <InboxRow
        answered={options.answered}
        bundle={row}
        cardActions={cardActions(acted, options)}
        // Conversations rows keep their Pin and Archive.
        itemActions={view !== "conversations"}
        conversation={
          // The stack's title names its Conversation.
          options.stacked
            ? undefined
            : (options.conversation ??
              data.conversationById.get(row.conversationId))
        }
        conversationId={row.conversationId}
        drag={options.drag}
        expanded={state.expandedKey === key}
        foldedNotices={data.foldedNotices}
        itemTitle={options.itemRow ? row.newest.title : undefined}
        itemSubtitle={
          options.itemRow
            ? itemRowSubtitle(
                options.subjectShown
                  ? { ...row.newest, subject: undefined }
                  : row.newest,
                // In a stack, a child's item names its sub-thread.
                options.stacked
                  ? row.newest.addedByLabel
                  : titleOf(row.conversationId),
              )
            : undefined
        }
        key={key}
        onItemAction={(item, body) => act(acted, [item], body)}
        onSnooze={
          options.snoozed
            ? undefined
            : (untilMs) => {
                setSnoozeKey(undefined);
                leave(key, () => snoozes.snooze(row, untilMs));
              }
        }
        onWake={
          options.snoozed
            ? () =>
                leave(key, () =>
                  options.stacked
                    ? snoozes.wakeItem(row.newest)
                    : snoozes.wake(row),
                )
            : undefined
        }
        onSnoozeMenu={(open) => setSnoozeKey(open ? key : undefined)}
        onToggle={() => toggle(key)}
        rowKey={key}
        selected={false}
        showThreads={!options.itemRow}
        snoozeMenuOpen={snoozeKey === key}
        take={options.take}
        time={options.time ?? row.waitingSince}
        title={title}
      />
    );
  };
  // Each item shows its own row. A root Conversation with more than one
  // item shows them as a stack, under the root's title.
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
        conversationId={row.conversationId}
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
          snooze: (untilMs) => {
            setSnoozeKey(undefined);
            leave(stackKey, () => snoozes.snooze(row, untilMs));
          },
          snoozed: options.snoozed,
        })}
        onSnoozeMenu={(open) => setSnoozeKey(open ? stackKey : undefined)}
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
  const conversationRow = (row: ConversationRow, drag?: PinnedRowDrag) => {
    const key = `conversation:${row.conversationId}`;
    const answered = row.conversation
      ? conversationAnswerLine(row.conversation)
      : undefined;
    if (row.bundle)
      return bundleRow(row.bundle, {
        answered,
        conversation: row.conversation,
        drag,
        key,
        time: row.time,
      });
    return (
      <InboxRow
        answered={answered}
        conversation={row.conversation}
        conversationId={row.conversationId}
        drag={drag}
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
  // In To do, an alert can be dismissed or snoozed in this browser.
  const automationRow = (
    automation: AutomationListItem,
    options: { todo?: boolean } = {},
  ) => {
    const key = `automation:${automation.id}`;
    return (
      <InboxAutomationRow
        automation={automation}
        expanded={state.expandedKey === key}
        key={key}
        onToggle={() => toggle(key)}
        putAway={
          options.todo
            ? {
                menuOpen: snoozeKey === key,
                onDismiss: () =>
                  leave(key, () => data.alerts.dismiss(automation)),
                onMenu: (open) => setSnoozeKey(open ? key : undefined),
                onSnooze: (untilMs) => {
                  setSnoozeKey(undefined);
                  leave(key, () => data.alerts.snooze(automation, untilMs));
                },
              }
            : undefined
        }
        rowKey={key}
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
        ? [data.feed]
        : view === "prs" || view === "decisions"
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

  const stream = () => {
    const shown = streamRows.slice(0, state.loaded);
    const pinned = shown.filter((row) => row.conversation?.pinnedAt);
    const rest = shown.filter((row) => !pinned.includes(row));
    const pinnedConversations = pinned.flatMap((row) =>
      row.conversation ? [row.conversation] : [],
    );
    return (
      <>
        <PinnedConversationOrder
          conversations={pinnedConversations}
          onError={(conversation) =>
            showActionError(conversation, "Could not reorder")
          }
          reorder={
            pinned.length === data.pinned.length ? reorderPins : undefined
          }
        >
          <InboxSection
            collapsed={collapsed.has("pinned")}
            count={pinned.length}
            label="Pinned"
            onToggle={() => toggleSection("pinned")}
          >
            {pinned.map((row) => (
              <DraggableRow
                conversationId={row.conversationId}
                key={row.conversationId}
                render={(drag) => conversationRow(row, drag)}
              />
            ))}
          </InboxSection>
        </PinnedConversationOrder>
        {timeGroups(rest, (row) => row.time, nowMs).map((section) => (
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
        ))}
      </>
    );
  };

  // A failed read must not look like nothing needs attention.
  const automationsError = data.automationsError ? (
    <InlineError className="py-3">Could not load your Automations.</InlineError>
  ) : null;
  let body;
  if (data.itemsError) {
    body = (
      <InlineError className="py-3">Could not load your asks.</InlineError>
    );
  } else if (!ready) {
    body = <RowsLoading />;
  } else if (view === "inbox") {
    // Empty only once Automations are in: they can still add To do cards,
    // and a failed read must not read as nothing left.
    const nothingLeft =
      data.automationsLoaded &&
      !todoMore &&
      data.todoRows.length +
        data.todoAutomations.length +
        data.grabRows.length +
        data.fyiRows.length ===
        0;
    const pinnedTodo = data.todoRows.filter((row) =>
      data.isPinned(row.conversationId),
    );
    body = (
      <>
        {data.signedIn ? (
          <InboxSection
            action={sweepControl(data.todoRows, "To do")}
            badge={
              data.todoCount ? (
                <span className="text-xs font-medium tabular-nums text-dashboard-text-muted">
                  {data.todoCount}
                </span>
              ) : null
            }
            collapsed={todoCollapsed}
            footer={todoEnd}
            // The rows show without the server count, which may still load
            // or have failed.
            count={
              data.todoCount ||
              data.todoRows.length + data.todoAutomations.length
            }
            label="To do"
            onToggle={() => setTodoCollapsed(!todoCollapsed)}
          >
            {[
              ...pinnedTodo,
              ...data.todoRows.filter((row) => !pinnedTodo.includes(row)),
            ].map((row) => stackRow(row, STACK_ROW_KEYS.todo, { todo: true }))}
            {data.todoAutomations.map((automation) =>
              automationRow(automation, { todo: true }),
            )}
          </InboxSection>
        ) : null}
        <InboxSection
          collapsed={collapsed.has("grabs")}
          count={data.grabRows.length}
          label="Up for grabs"
          onToggle={() => toggleSection("grabs")}
        >
          {data.grabRows.map((row) =>
            stackRow(row, STACK_ROW_KEYS.grabs, { take: "I'll take it" }),
          )}
        </InboxSection>
        {/* Notices wait on no one: quiet rows, stacked, after the asks. */}
        <InboxSection
          action={sweepControl(data.fyiRows, "FYI")}
          collapsed={collapsed.has("fyi")}
          count={data.fyiRows.reduce((sum, row) => sum + row.items.length, 0)}
          label="FYI"
          onToggle={() => toggleSection("fyi")}
        >
          {data.fyiRows.map((row) => stackRow(row, STACK_ROW_KEYS.fyi, {}))}
        </InboxSection>
        {automationsError}
        {nothingLeft ? <InboxEmptyState label="Nothing left here" /> : null}
      </>
    );
  } else if (view === "conversations") {
    body =
      streamRows.length === 0 ? (
        <InboxEmptyState label="No conversations yet" />
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
    body =
      data.snoozedRows.length === 0 ? (
        <InboxEmptyState label="Nothing snoozed" />
      ) : (
        // Snoozed rows expand in place like the others, and wake there.
        <ul className="m-0 grid gap-2 p-0 pt-1" data-dock-list="">
          {data.snoozedRows.map((row) =>
            stackRow(row, STACK_ROW_KEYS.snoozed, { snoozed: true }),
          )}
        </ul>
      );
  } else if (view === "prs") {
    body = pullRequests.loading ? (
      <RowsLoading />
    ) : pullRequests.sections.length === 0 ? (
      <InboxEmptyState label="Nothing left here" />
    ) : (
      pullRequests.sections.map((section) => (
        <InboxSection
          action={sweepControl(
            [...section.changes.flatMap((row) => row.items), ...section.items],
            section.label,
          )}
          collapsed={
            collapsed.has(section.key) !== Boolean(section.collapsedByDefault)
          }
          count={section.changes.length + section.items.length}
          key={section.key}
          label={section.label}
          onToggle={() => toggleSection(section.key)}
        >
          {section.changes.map((row) => (
            <PullRequestChange
              expanded={row.items.some(
                (item) => state.expandedKey === item.key,
              )}
              key={row.change.id}
              nowMs={pullRequests.nowMs}
              row={row}
            >
              {row.items.length > 0
                ? row.items.map((item) =>
                    bundleRow(item, { itemRow: true, subjectShown: true }),
                  )
                : null}
            </PullRequestChange>
          ))}
          {section.items.map((row) => bundleRow(row, { itemRow: true }))}
        </InboxSection>
      ))
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
  return (
    <section
      aria-label={INBOX_VIEW_LABELS[view]}
      className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg"
    >
      {heading && !props.phone ? (
        <HeaderBar title={heading} />
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
  );
}

/**
 * Old Inbox links and the current UI's review desk links open the list:
 * `?bundle=` picks the matching entry, and `?item=` expands that item's
 * row, on Done when the item has closed.
 */
export function InboxRedirect() {
  const [params] = useSearchParams();
  const bundle = params.get("bundle");
  const itemId = params.get("item") ?? undefined;
  // Only a link with no entry needs the item's status.
  const item = useReviewItemData(bundle ? undefined : itemId);
  if (bundle === "automations") return <Navigate replace to="/automations" />;
  if (!bundle && itemId && item.isPending) return null;
  const view =
    bundle === "prs" || bundle === "decisions" || bundle === "done"
      ? bundle
      : item.data && item.data.status !== "open"
        ? "done"
        : "inbox";
  return <Navigate replace to={inboxViewPath(view, { itemId })} />;
}
