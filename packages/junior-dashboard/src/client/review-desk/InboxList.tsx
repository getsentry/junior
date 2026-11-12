import { useLocalStorage } from "@uidotdev/usehooks";
import { CheckCheck } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import type { AutomationSummary } from "@sentry/junior/api/schema";

import { useDocumentTitle } from "../documentTitle";
import { InlineError } from "../components/InlineError";
import { PaneCollapsedControls } from "../components/layout/PaneNav";
import { Button } from "../components/ui/button";
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
import { useInboxListState, useLinkedInboxItems } from "./inboxListState";
import {
  automationSections,
  INBOX_VIEW_LABELS,
  inboxViewPath,
  sweepOf,
  TIME_SECTIONS,
  timeSectionAt,
  viewRows,
  viewSections,
} from "./inboxModel";
import { InboxRow } from "./InboxRow";
import { InboxSection } from "./InboxSection";
import {
  useReviewItemAction,
  useReviewItemData,
  useReviewItemsData,
  scrollPages,
} from "./queries";
import type { InboxBundle } from "./reviewItemFormat";

const TODO_COLLAPSED_KEY = "junior:inbox:todo-collapsed";

/** Clear the notices and FYI items in some rows. Asks stay. */
function SweepControl(props: {
  clear: number;
  onSweep(): void;
  scope: string;
}) {
  if (props.clear === 0) return null;
  return (
    <Button
      aria-label={`Clear ${props.clear} in ${props.scope}`}
      className="h-6 gap-1 px-1.5 text-xs"
      onClick={props.onSweep}
      title="Mark notices and FYI items done. Questions and approvals stay."
      variant="ghost"
    >
      <CheckCheck aria-hidden="true" className="size-3.5" />
      Clear {props.clear}
    </Button>
  );
}

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

function EmptyState(props: { label: string }) {
  return (
    <p className="m-0 py-16 text-center font-display text-base font-medium text-dashboard-text">
      {props.label}
    </p>
  );
}

/** Split rows into Today, This week, and Earlier, keeping their order. */
function timeGroups<Row>(
  rows: readonly Row[],
  timeOf: (row: Row) => string,
  nowMs: number,
) {
  return TIME_SECTIONS.map((section) => ({
    ...section,
    rows: rows.filter(
      (row) => timeSectionAt(timeOf(row), nowMs) === section.key,
    ),
  })).filter((section) => section.rows.length > 0);
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
  const action = useReviewItemAction();
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

  const todoIds = new Set(data.todoRows.map((row) => row.conversationId));
  const pullRequests = usePullRequestSections(
    viewRows(data.awake, "prs"),
    view === "prs",
  );
  const streamRows =
    view === "inbox"
      ? data.conversationRows.filter((row) => !todoIds.has(row.conversationId))
      : view === "conversations"
        ? data.conversationRows
        : [];

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
  // A snoozed item is still open. Its link opens Snoozed, with its row.
  const snoozedKey = linkedId
    ? data.snoozedRows.find((row) =>
        row.items.some((item) => item.id === linkedId),
      )?.key
    : undefined;
  const linkedRowKey = (() => {
    if (!linkedId) return undefined;
    if (view === "snoozed") return snoozedKey;
    if (view === "done")
      return doneItems.some((item) => item.id === linkedId)
        ? linkedId
        : undefined;
    const item = data.awake.find((open) => open.id === linkedId);
    if (!item) return undefined;
    if (view === "prs" || view === "decisions") return item.id;
    const conversationId = item.addedByConversationId;
    return view === "inbox" && todoIds.has(conversationId)
      ? `todo:${conversationId}`
      : `conversation:${conversationId}`;
  })();
  const linkedLoaded =
    view === "done" ? Boolean(done.query.data) : ready && !linkedRowKey;
  // An item that is not in this list may be closed, or past its first page.
  const linked = useReviewItemData(
    linkedId && !linkedRowKey && linkedLoaded ? linkedId : undefined,
  );
  // Stream rows show a page at a time, so a linked row can be past them.
  const linkedStreamIndex = linkedRowKey
    ? streamRows.findIndex(
        (row) => `conversation:${row.conversationId}` === linkedRowKey,
      )
    : -1;
  const { expandedKey, listPath, loaded, setExpandedKey, showMore } = state;
  const { includedId, includeItem } = data;
  useEffect(() => {
    if (!linkedId) return;
    if (linkedRowKey) {
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
      // Effects run after the render commits, so the expanded row is here.
      document
        .querySelector(`[data-inbox-row="${CSS.escape(linkedRowKey)}"]`)
        ?.scrollIntoView({ block: "center" });
      navigate(listPath, { replace: true });
      return;
    }
    if (snoozedKey) {
      navigate(inboxViewPath("snoozed", { itemId: linkedId }), {
        replace: true,
      });
      return;
    }
    if (!linkedLoaded) return;
    if (linked.error) {
      navigate(listPath, { replace: true });
      return;
    }
    if (!linked.data) return;
    if (linked.data.status === "open") {
      // Past the loaded page, it joins the list, and its row expands on the
      // next render. Snoozed or swept, it has no row to expand.
      if (includedId !== linkedId) includeItem(linkedId);
      else navigate(listPath, { replace: true });
    } else if (view === "done") {
      const closedId = linked.data.id;
      setLinkedItems((current) => ({ ...current, closed: closedId }));
    } else {
      navigate(inboxViewPath("done", { itemId: linkedId }), { replace: true });
    }
  }, [
    expandedKey,
    includeItem,
    includedId,
    linked.data,
    linked.error,
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
    showMore,
    snoozedKey,
    view,
  ]);

  const sweepControl = (rows: readonly InboxBundle[], scope: string) => (
    <SweepControl
      clear={sweepOf(rows, data.isPinned).length}
      onSweep={() => sweeper.sweep(sweepOf(rows, data.isPinned))}
      scope={scope}
    />
  );
  const markDone = async (bundle: InboxBundle) => {
    for (const item of bundle.items) {
      if (item.status !== "open" || !item.canAct) continue;
      const closed = await action
        .mutateAsync({ body: { action: "dismiss" }, id: item.id })
        .then(
          () => true,
          () => false,
        );
      if (!closed) return;
    }
  };

  const bundleRow = (
    row: InboxBundle,
    options: {
      conversation?: Conversation;
      drag?: PinnedRowDrag;
      itemRow?: boolean;
      key?: string;
      /** A snoozed row wakes instead of snoozing. */
      snoozed?: boolean;
      time?: string;
    } = {},
  ) => {
    const key = options.key ?? row.key;
    return (
      <InboxRow
        bundle={row}
        conversation={
          options.conversation ?? data.conversationById.get(row.conversationId)
        }
        conversationId={row.conversationId}
        donePending={action.isPending}
        drag={options.drag}
        expanded={state.expandedKey === key}
        itemTitle={options.itemRow ? row.newest.title : undefined}
        key={key}
        onDone={() => void markDone(row)}
        onSnooze={
          options.snoozed
            ? undefined
            : (choice) => {
                snoozes.snooze(row, choice);
                setSnoozeKey(undefined);
              }
        }
        onWake={options.snoozed ? () => snoozes.wake(row) : undefined}
        onSnoozeMenu={(open) => setSnoozeKey(open ? key : undefined)}
        onToggle={() => toggle(key)}
        rowKey={key}
        selected={false}
        showThreads={!options.itemRow}
        snoozeMenuOpen={snoozeKey === key}
        time={options.time ?? row.waitingSince}
        title={titleOf(row.conversationId) ?? row.newest.title}
      />
    );
  };
  const conversationRow = (row: ConversationRow, drag?: PinnedRowDrag) => {
    const key = `conversation:${row.conversationId}`;
    if (row.bundle)
      return bundleRow(row.bundle, {
        conversation: row.conversation,
        drag,
        key,
        time: row.time,
      });
    return (
      <InboxRow
        conversation={row.conversation}
        conversationId={row.conversationId}
        drag={drag}
        expanded={false}
        key={key}
        onSnoozeMenu={() => undefined}
        onToggle={() => undefined}
        rowKey={key}
        selected={false}
        showThreads
        snoozeMenuOpen={false}
        time={row.time}
        title={row.conversation?.displayTitle ?? "Conversation"}
      />
    );
  };
  const automationRow = (automation: AutomationSummary) => {
    const key = `automation:${automation.id}`;
    return (
      <InboxAutomationRow
        automation={automation}
        expanded={state.expandedKey === key}
        key={key}
        onToggle={() => toggle(key)}
        rowKey={key}
      />
    );
  };

  // Infinite scroll: stream rows render a page at a time as the end comes
  // into view. When every loaded row shows, the next page of what the list
  // reads loads: the feed, the open asks, or Done.
  const sentinel = useRef<HTMLDivElement>(null);
  const hidden = Math.max(0, streamRows.length - state.loaded);
  const pages: InboxFeedPages[] =
    view === "inbox"
      ? [data.feed, data.itemPages]
      : view === "conversations"
        ? [data.feed]
        : view === "prs" || view === "decisions"
          ? [data.itemPages]
          : view === "done"
            ? [donePages]
            : [];
  // A failed page read stops only new reads. Rows already loaded still
  // show as the reader scrolls, and Try again shows once they all do.
  const failed = hidden > 0 ? [] : pages.filter((source) => source.failed);
  const more =
    hidden > 0 ||
    (failed.length === 0 && pages.some((source) => source.hasMore));
  const loadingMore = pages.some((source) => source.loadingMore);
  const loadNext = useEffectEvent(() => {
    if (hidden > 0) state.showMore();
    else for (const source of pages) source.loadMore();
  });
  // A new observer reports at once, so the list keeps loading while its
  // end shows: it starts again when the list is ready, and whenever more
  // rows arrive or show.
  const progress = [
    state.loaded,
    streamRows.length,
    data.awake.length,
    doneItems.length,
    ...pages.map((source) => source.loadingMore),
  ].join();
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNext();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, progress, ready, view]);
  const listEnd = !ready ? null : failed.length > 0 ? (
    <div className="flex items-center justify-center gap-2 py-3 text-xs">
      <InlineError className="w-auto">Could not load more.</InlineError>
      <Button
        className="h-7 px-2 text-xs"
        disabled={loadingMore}
        onClick={() => {
          for (const source of failed) source.retry();
        }}
        variant="ghost"
      >
        Try again
      </Button>
    </div>
  ) : more ? (
    <div
      className="py-3 text-center font-sans text-xs text-dashboard-text-muted"
      ref={sentinel}
      role="status"
    >
      {hidden > 0 || loadingMore ? "Loading more…" : null}
    </div>
  ) : null;

  const stream = () => {
    const shown = streamRows.slice(0, state.loaded);
    const pinned =
      view === "conversations"
        ? shown.filter((row) => row.conversation?.pinnedAt)
        : [];
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
          reorder={pinned.length === data.pinnedCount ? reorderPins : undefined}
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
    const pinnedTodo = data.todoRows.filter((row) =>
      data.isPinned(row.conversationId),
    );
    body = (
      <>
        {data.signedIn ? (
          <InboxSection
            action={sweepControl(data.todoRows, "To do")}
            badge={
              data.todoCount > 0 ? (
                <span className="mb-0.5 rounded-full bg-dashboard-accent px-1.5 text-2xs font-semibold leading-4 tabular-nums text-dashboard-text-inverse">
                  {data.todoCount}
                </span>
              ) : null
            }
            collapsed={todoCollapsed}
            // The rows show without the server count, which may still load
            // or have failed.
            count={
              data.todoCount || data.todoRows.length + data.automations.length
            }
            label="To do"
            onToggle={() => setTodoCollapsed(!todoCollapsed)}
          >
            {[
              ...pinnedTodo,
              ...data.todoRows.filter((row) => !pinnedTodo.includes(row)),
            ].map((row) => bundleRow(row, { key: `todo:${row.key}` }))}
            {data.automations.map(automationRow)}
          </InboxSection>
        ) : null}
        {automationsError}
        {stream()}
      </>
    );
  } else if (view === "conversations") {
    body =
      streamRows.length === 0 ? (
        <EmptyState label="No conversations yet" />
      ) : (
        stream()
      );
  } else if (view === "automations") {
    const sections = automationSections(data.automations);
    body = data.automationsError ? (
      automationsError
    ) : sections.length === 0 ? (
      <EmptyState label="No Automations need attention" />
    ) : (
      sections.map((section) => (
        <InboxSection
          collapsed={collapsed.has(section.label)}
          count={section.automations.length}
          key={section.label}
          label={section.label}
          onToggle={() => toggleSection(section.label)}
        >
          {section.automations.map(automationRow)}
        </InboxSection>
      ))
    );
  } else if (view === "done") {
    body = !done.query.data ? (
      <RowsLoading />
    ) : doneItems.length === 0 ? (
      <EmptyState label="Nothing done yet" />
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
        <EmptyState label="Nothing snoozed" />
      ) : (
        // Snoozed rows expand in place like the others, and wake there.
        <ul className="m-0 grid gap-2 p-0 pt-1">
          {data.snoozedRows.map((row) => bundleRow(row, { snoozed: true }))}
        </ul>
      );
  } else if (view === "prs") {
    body = pullRequests.loading ? (
      <RowsLoading />
    ) : pullRequests.sections.length === 0 ? (
      <EmptyState label="Nothing left here" />
    ) : (
      pullRequests.sections.map((section) => (
        <InboxSection
          action={sweepControl(
            [...section.changes.flatMap((row) => row.items), ...section.items],
            section.label,
          )}
          collapsed={collapsed.has(section.key)}
          count={section.changes.length + section.items.length}
          key={section.key}
          label={section.label}
          onToggle={() => toggleSection(section.key)}
        >
          {section.changes.map((row) => (
            <PullRequestChange
              key={row.change.id}
              nowMs={pullRequests.nowMs}
              row={row}
            >
              {row.items.length > 0
                ? row.items.map((item) => bundleRow(item, { itemRow: true }))
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
        <EmptyState label="Nothing left here" />
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

  // The Inbox has no heading; a bundle shows only its name.
  const heading = view === "inbox" ? undefined : INBOX_VIEW_LABELS[view];
  return (
    <section
      aria-label={INBOX_VIEW_LABELS[view]}
      className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg"
    >
      {heading && !props.phone ? (
        <div className="flex h-header min-w-0 items-center gap-2 border-b border-dashboard-border-subtle pr-4 pl-6">
          <PaneCollapsedControls />
          <h1 className="m-0 font-display text-lg font-medium tracking-[-0.01em] text-dashboard-text">
            {heading}
          </h1>
        </div>
      ) : (
        <div className="absolute top-2 left-3 z-10 max-md:hidden">
          <PaneCollapsedControls />
        </div>
      )}
      <div
        className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
        onScroll={state.onScroll}
        ref={state.scroller}
      >
        <div
          className={cn(
            "mx-auto w-full max-w-[56rem] pb-16",
            props.phone ? "px-2 pt-1" : "px-6 pt-3",
          )}
        >
          {action.isError ? (
            <InlineError className="py-2">
              Could not close every item. Try again.
            </InlineError>
          ) : null}
          {body}
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
 * Old Inbox links open the list: `?bundle=` picks the matching entry, and
 * `?item=` expands that item's row.
 */
export function InboxRedirect() {
  const [params] = useSearchParams();
  const bundle = params.get("bundle");
  const view =
    bundle === "prs" ||
    bundle === "decisions" ||
    bundle === "automations" ||
    bundle === "done"
      ? bundle
      : "inbox";
  return (
    <Navigate
      replace
      to={inboxViewPath(view, { itemId: params.get("item") ?? undefined })}
    />
  );
}
