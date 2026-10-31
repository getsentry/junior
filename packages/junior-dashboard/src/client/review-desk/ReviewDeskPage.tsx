import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { FilterTabList } from "../components/FilterBar";
import { InlineError } from "../components/InlineError";
import { SearchInput } from "../components/SearchInput";
import { StatusChip } from "../components/StatusChip";
import { Card } from "../components/layout/Card";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
import { Skeleton } from "../components/ui/skeleton";
import { automationPath, formatRelativeTime } from "../format";
import {
  parseSearchParamEnum,
  pathWithSearch,
  useDebouncedSearchParam,
} from "../searchParams";
import { cn } from "../styles";
import { ReviewItemDetail } from "./ReviewItemDetail";
import {
  REVIEW_DESK_VIEWS,
  useBlockedAutomationsData,
  useReviewItemData,
  useReviewItemsData,
} from "./queries";
import { assigneeLabel, reviewItemPath } from "./reviewItemFormat";

const VIEW_TABS = [
  { label: "Mine", value: "mine" },
  { label: "Everyone", value: "everyone" },
  { label: "All", value: "all" },
] as const;

const STATE_TABS = [
  { label: "Open", value: "open" },
  { label: "Archived", value: "archived" },
] as const;

const ITEM_STATES = ["open", "archived"] as const;

const rowClass =
  "grid gap-0.5 rounded-md px-3 py-2 text-inherit no-underline transition-colors";

function ListGroup(props: { children: ReactNode; title: string }) {
  return (
    <section className="grid gap-1">
      <h2 className="m-0 px-3 font-sans text-xs font-medium text-dashboard-text-muted">
        {props.title}
      </h2>
      <ul className="m-0 grid list-none gap-0.5 p-0">{props.children}</ul>
    </section>
  );
}

function ItemRow(props: {
  item: ReviewItemPayload;
  searchParams: URLSearchParams;
  selected: boolean;
}) {
  const { item } = props;
  const unassigned = !item.assignedToEveryone && item.assignees.length === 0;
  return (
    <li>
      <Link
        aria-current={props.selected ? "true" : undefined}
        className={cn(
          rowClass,
          props.selected
            ? "bg-dashboard-accent/[0.08]"
            : "hover:bg-dashboard-fill-soft",
        )}
        replace
        to={pathWithSearch(reviewItemPath(item.id), props.searchParams)}
      >
        <span className="truncate text-sm font-medium">{item.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-dashboard-text-muted">
          {unassigned ? (
            <StatusChip size="compact" tone="warning">
              Unassigned
            </StatusChip>
          ) : (
            <span className="truncate">{assigneeLabel(item)}</span>
          )}
          <span className="shrink-0">
            {formatRelativeTime(item.closedAt ?? item.updatedAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}

function BlockedAutomationRow(props: { automation: AutomationSummary }) {
  return (
    <li>
      <Link
        className={cn(rowClass, "hover:bg-dashboard-fill-soft")}
        to={automationPath(props.automation.id)}
      >
        <span className="truncate text-sm font-medium">
          {props.automation.title}
        </span>
        <span className="truncate text-xs text-amber-300">
          {props.automation.statusReason ?? "Blocked"}
        </span>
      </Link>
    </li>
  );
}

function ReviewListLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading review items"
      className="grid gap-2"
    >
      {[0, 1, 2, 3].map((row) => (
        <div className="grid gap-1.5 px-3 py-2" key={row}>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * Render the review desk: open or archived Review items in the Mine,
 * Everyone, and All views, with the selected item beside the list.
 */
export function ReviewDeskPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view =
    parseSearchParamEnum(searchParams.get("view"), REVIEW_DESK_VIEWS) ?? "mine";
  const state =
    parseSearchParamEnum(searchParams.get("state"), ITEM_STATES) ?? "open";
  // The selected item can be missing from the new list, so a tab change
  // drops it and the first item of the new list shows.
  function selectTab(key: "state" | "view", value: string, initial: string) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("item");
        if (value === initial) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }
  const [search, setSearch, q] = useDebouncedSearchParam();
  const archived = state === "archived";
  const items = useReviewItemsData({ archived, q, view });
  const showBlocked = !archived && view !== "everyone" && !q;
  const blocked = useBlockedAutomationsData(showBlocked);
  const list = items.data?.items ?? [];
  const selectedId = searchParams.get("item") ?? list[0]?.id;
  const listed = list.find((item) => item.id === selectedId);
  // A link can select an item that is not in the current view.
  const direct = useReviewItemData(listed ? undefined : selectedId);
  const selected = listed ?? direct.data;
  const actions = list.filter((item) => item.kind === "action");
  const notices = list.filter((item) => item.kind === "notice");
  const blockedAutomations = showBlocked
    ? (blocked.data?.automations ?? [])
    : [];
  const empty =
    items.data && list.length === 0 && blockedAutomations.length === 0;

  return (
    <PageLayout>
      <PageHeader
        description="Items that need a person, and who can act on them."
        title="Review desk"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <FilterTabList
          ariaLabel="Assignee view"
          items={VIEW_TABS}
          onChange={(value) => selectTab("view", value, "mine")}
          value={view}
        />
        <FilterTabList
          ariaLabel="Item state"
          items={STATE_TABS}
          onChange={(value) => selectTab("state", value, "open")}
          value={state}
        />
        <SearchInput
          className="ml-auto w-full sm:w-64"
          label="Search review items"
          onChange={setSearch}
          placeholder="Search items"
          value={search}
        />
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="grid content-start gap-4 py-3" padding="none">
          {items.error ? (
            <InlineError className="px-3">
              Could not load review items.
            </InlineError>
          ) : !items.data ? (
            <ReviewListLoading />
          ) : empty ? (
            <EmptyTelemetry>
              {archived ? "No archived items." : "Nothing needs you right now."}
            </EmptyTelemetry>
          ) : (
            <>
              {actions.length > 0 ? (
                <ListGroup title={archived ? "Questions" : "Needs an answer"}>
                  {actions.map((item) => (
                    <ItemRow
                      item={item}
                      key={item.id}
                      searchParams={searchParams}
                      selected={item.id === selected?.id}
                    />
                  ))}
                </ListGroup>
              ) : null}
              {notices.length > 0 ? (
                <ListGroup title="Notices">
                  {notices.map((item) => (
                    <ItemRow
                      item={item}
                      key={item.id}
                      searchParams={searchParams}
                      selected={item.id === selected?.id}
                    />
                  ))}
                </ListGroup>
              ) : null}
              {blockedAutomations.length > 0 ? (
                <ListGroup title="Blocked Automations">
                  {blockedAutomations.map((automation) => (
                    <BlockedAutomationRow
                      automation={automation}
                      key={automation.id}
                    />
                  ))}
                </ListGroup>
              ) : null}
            </>
          )}
        </Card>
        <Card className="min-w-0" padding="md">
          {selected ? (
            <ReviewItemDetail item={selected} />
          ) : direct.error ? (
            <InlineError>Review item not found.</InlineError>
          ) : (
            <EmptyTelemetry>Select an item to see it here.</EmptyTelemetry>
          )}
        </Card>
      </div>
    </PageLayout>
  );
}
