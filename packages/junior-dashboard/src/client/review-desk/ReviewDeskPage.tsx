import { Archive } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { InlineError } from "../components/InlineError";
import { SearchInput } from "../components/SearchInput";
import { StatusChip } from "../components/StatusChip";
import { Card } from "../components/layout/Card";
import { PageHeader } from "../components/layout/PageHeader";
import { PageLayout } from "../components/layout/PageLayout";
import { Skeleton } from "../components/ui/skeleton";
import { automationPath, formatRelativeTime } from "../format";
import { pathWithSearch, useDebouncedSearchParam } from "../searchParams";
import { cn } from "../styles";
import { ReviewItemDetail } from "./ReviewItemDetail";
import {
  useBlockedAutomationsData,
  useReviewItemData,
  useReviewItemsData,
} from "./queries";
import {
  assigneeLabel,
  reviewItemPath,
  reviewItemStatusLabel,
} from "./reviewItemFormat";

const rowClass =
  "grid gap-0.5 rounded-md px-3 py-2 text-inherit no-underline transition-colors";

// The list and the detail are already cards, so an empty state is plain
// text, not a second box.
function EmptyMessage(props: { children: ReactNode }) {
  return (
    <p className="m-0 px-4 py-8 text-center text-sm text-dashboard-text-muted">
      {props.children}
    </p>
  );
}

function ListGroup(props: {
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  title: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid gap-1", props.className)}
    >
      <h2
        id={headingId}
        className="m-0 flex items-center gap-1.5 px-3 font-sans text-xs font-medium text-dashboard-text-muted"
      >
        {props.icon}
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
  const closed = item.status !== "open";
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
        <span
          className={cn(
            "truncate text-sm font-medium",
            closed && "text-dashboard-text-muted",
          )}
        >
          {item.title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-dashboard-text-muted">
          {closed ? (
            <StatusChip className="shrink-0" size="compact">
              {reviewItemStatusLabel(item)}
            </StatusChip>
          ) : unassigned ? (
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
 * Render the review desk: the open Review items that the viewer can see,
 * with search and the selected item beside the list. A search also finds
 * archived items, which show in their own group.
 */
export function ReviewDeskPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch, q] = useDebouncedSearchParam();
  const items = useReviewItemsData({ q });
  const showBlocked = !q;
  const blocked = useBlockedAutomationsData(showBlocked);
  const list = items.data?.items ?? [];
  const selectedId = searchParams.get("item") ?? list[0]?.id;
  const listed = list.find((item) => item.id === selectedId);
  // A link can select an item that is not in the current view.
  const direct = useReviewItemData(listed ? undefined : selectedId);
  const selected = listed ?? direct.data;
  const open = list.filter((item) => item.status === "open");
  const archived = list.filter((item) => item.status !== "open");
  const actions = open.filter((item) => item.kind === "action");
  const notices = open.filter((item) => item.kind === "notice");
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
      <SearchInput
        label="Search review items"
        onChange={setSearch}
        placeholder="Search open and archived items"
        value={search}
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card
          className="grid content-start gap-4 py-3 lg:self-start"
          padding="none"
        >
          {items.error ? (
            <InlineError className="px-3">
              Could not load review items.
            </InlineError>
          ) : !items.data ? (
            <ReviewListLoading />
          ) : empty ? (
            <EmptyMessage>
              {q ? `No items match "${q}".` : "No open items."}
            </EmptyMessage>
          ) : (
            <>
              {actions.length > 0 ? (
                <ListGroup title="Needs an answer">
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
              {archived.length > 0 ? (
                <ListGroup
                  className={
                    open.length > 0
                      ? "border-t border-dashboard-border-subtle pt-3"
                      : undefined
                  }
                  icon={<Archive aria-hidden="true" size={13} />}
                  title="Archived"
                >
                  {archived.map((item) => (
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
            // A key per item resets the answer form and its send lock, so
            // one item's answer can never reach another item.
            <ReviewItemDetail item={selected} key={selected.id} />
          ) : direct.error ? (
            <InlineError>Review item not found.</InlineError>
          ) : (
            <EmptyMessage>Select an item to see it here.</EmptyMessage>
          )}
        </Card>
      </div>
    </PageLayout>
  );
}
