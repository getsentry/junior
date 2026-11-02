import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { LoadMorePagination } from "../components/Pagination";
import { useDetailsPanel } from "../components/DetailsPanel";
import { Skeleton } from "../components/ui/skeleton";
import { useDocumentTitle } from "../documentTitle";
import { pathWithSearch, useDebouncedSearchParam } from "../searchParams";
import { cn } from "../styles";
import { ReviewDeskSidebar, type InboxGroupKey } from "./ReviewDeskSidebar";
import { ReviewItemDetails } from "./ReviewItemDetails";
import { ReviewItemView } from "./ReviewItemView";
import {
  useBlockedAutomationsData,
  useLinkedConversationTitles,
  useReviewItemData,
  useReviewItemsData,
} from "./queries";
import { inboxGroups, nextInboxItem, reviewItemPath } from "./reviewItemFormat";

const shellClass =
  "grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg md:grid-cols-[20rem_minmax(0,1fr)]";

function InboxEmpty(props: { className?: string }) {
  return (
    <div
      className={cn(
        "grid content-center justify-items-center gap-3 px-4 py-12 text-center",
        props.className,
      )}
    >
      <p className="m-0 font-display text-lg font-medium text-dashboard-text">
        Nothing needs you
      </p>
    </div>
  );
}

/** Keep the inbox frame while the dashboard shell loads. */
export function ReviewDeskLoading() {
  return (
    <div className={shellClass}>
      <aside
        aria-busy="true"
        aria-label="Loading review items"
        className="grid content-start gap-2 border-r border-dashboard-border bg-dashboard-surface-panel px-5 py-3"
      >
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-8 w-full" />
        {[0, 1, 2, 3].map((row) => (
          <div className="grid gap-1 py-2" key={row}>
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-2/5 opacity-70" />
          </div>
        ))}
      </aside>
    </div>
  );
}

/**
 * Render the inbox: Review items that the viewer can see in a sidebar, and
 * one selected item with the end of its Conversation, where the viewer
 * decides it. Details show beside the item, or in a sheet on small screens.
 */
export function ReviewDeskPage() {
  useDocumentTitle("Inbox");
  const [searchParams] = useSearchParams();
  const [search, setSearch, q] = useDebouncedSearchParam();
  const { items: list, moreArchived, query: items } = useReviewItemsData({ q });
  const showBlocked = !q;
  const blocked = useBlockedAutomationsData(showBlocked);
  const blockedAutomations = showBlocked
    ? (blocked.data?.automations ?? [])
    : [];
  const groups = useMemo(() => inboxGroups(list), [list]);
  // A search lists every match in one list. Later pages add open items, so
  // keep open matches before archived ones.
  const results = useMemo(
    () =>
      q
        ? [
            ...list.filter((item) => item.status === "open"),
            ...list.filter((item) => item.status !== "open"),
          ]
        : undefined,
    [list, q],
  );
  const open = [...groups.needsYou, ...groups.fyi];

  const [collapsed, setCollapsed] = useState<ReadonlySet<InboxGroupKey>>(
    () => new Set(),
  );
  const toggle = (key: InboxGroupKey) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const itemParam = searchParams.get("item") ?? undefined;
  // Wide screens select the item that waited longest. Small screens show
  // the list until the reader picks an item.
  const selectedId = itemParam ?? open[0]?.id;
  const listed = list.find((item) => item.id === selectedId);
  // A link can select an item that is not in the current view.
  const direct = useReviewItemData(listed ? undefined : selectedId);
  const selected = listed ?? direct.data;
  const nextItem = selected ? nextInboxItem(groups, selected) : undefined;

  // Read source titles only for the rows on screen and the selected item.
  const sourceIds = useMemo(() => {
    const rows = results ?? [
      ...(collapsed.has("needs-you") ? [] : groups.needsYou),
      ...(collapsed.has("fyi") ? [] : groups.fyi),
    ];
    const shown = selected ? [...rows, selected] : rows;
    return [
      ...new Set(
        shown
          .filter((item) => !item.automationId)
          .map((item) => item.addedByConversationId),
      ),
    ];
  }, [collapsed, groups, results, selected]);
  const sourceTitles = useLinkedConversationTitles(sourceIds);
  const sourceTitle = (item: ReviewItemPayload) =>
    sourceTitles[sourceIds.indexOf(item.addedByConversationId)];

  const panelFits = useDetailsPanel();
  const [detailsChoice, setDetailsChoice] = useState<boolean>();
  const detailsOpen = Boolean(selected) && (detailsChoice ?? panelFits);

  const listParams = new URLSearchParams(searchParams);
  listParams.delete("item");
  const loaded = Boolean(items.data);
  const empty =
    loaded && !q && open.length === 0 && blockedAutomations.length === 0;

  return (
    <div className={shellClass}>
      <div
        className={cn(
          "h-full min-h-0 overflow-hidden",
          itemParam && "max-md:hidden",
        )}
      >
        <ReviewDeskSidebar
          blocked={blockedAutomations}
          collapsed={collapsed}
          error={Boolean(items.error && !items.data)}
          footer={
            <>
              <LoadMorePagination
                className="mx-3 mt-2"
                hasMore={!items.isPlaceholderData && Boolean(items.hasNextPage)}
                loading={items.isFetchingNextPage}
                onLoadMore={() => void items.fetchNextPage()}
              />
              {items.isFetchNextPageError ? (
                <InlineError className="px-3 py-2">
                  Could not load more items. Try again.
                </InlineError>
              ) : null}
              {moreArchived ? (
                <p className="m-0 px-3 py-2 text-xs text-dashboard-text-muted">
                  Narrow the search to find older archived items.
                </p>
              ) : null}
              {loaded && q && list.length === 0 ? (
                <p className="m-0 px-3 py-8 text-center text-sm text-dashboard-text-muted">
                  No items match "{q}".
                </p>
              ) : null}
              {empty ? <InboxEmpty className="md:hidden" /> : null}
            </>
          }
          fyi={groups.fyi}
          loading={!items.data && !items.error}
          needsYou={groups.needsYou}
          onSearchChange={setSearch}
          onToggle={toggle}
          results={results}
          search={search}
          searchParams={listParams}
          selectedId={selected?.id}
          selectedShown={Boolean(itemParam)}
          sourceTitle={sourceTitle}
        />
      </div>
      <section
        aria-label="Selected review item"
        className={cn(
          "grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden",
          !itemParam && "max-md:hidden",
          detailsOpen && "xl:grid-cols-[minmax(0,1fr)_25rem]",
        )}
      >
        {selected ? (
          <>
            <ReviewItemView
              backTo={pathWithSearch("/review", listParams)}
              detailsOpen={detailsOpen}
              item={selected}
              // A key per item resets the answer form and its send lock, so
              // one item's answer can never reach another item.
              key={selected.id}
              next={
                nextItem
                  ? {
                      title: nextItem.title,
                      to: pathWithSearch(
                        reviewItemPath(nextItem.id),
                        listParams,
                      ),
                    }
                  : undefined
              }
              onDetailsClick={() => setDetailsChoice(!detailsOpen)}
              sourceTitle={sourceTitle(selected)}
            />
            {detailsOpen ? (
              <ReviewItemDetails
                item={selected}
                onClose={() => setDetailsChoice(false)}
              />
            ) : null}
          </>
        ) : direct.error ? (
          <InlineError className="p-7">Review item not found.</InlineError>
        ) : empty ? (
          <InboxEmpty />
        ) : null}
      </section>
    </div>
  );
}
