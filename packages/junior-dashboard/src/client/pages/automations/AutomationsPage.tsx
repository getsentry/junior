import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  automationListQuerySchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { ChevronRight } from "lucide-react";
import { useAutomationsData } from "../../api";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { FilterToolbar } from "../../components/filters/FilterToolbar";
import {
  activeAutomationFilters,
  AutomationFilterPanel,
} from "./AutomationFilters";
import { InlineError } from "../../components/InlineError";
import { FilteredList } from "../../components/filters/FilterPanel";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { automationPath } from "../../format";
import { pathWithSearch, useDebouncedSearchParam } from "../../searchParams";
import { cn } from "../../styles";
import { AutomationRow } from "./AutomationRow";
import { automationNeedsAttention } from "./AutomationStatus";

const EMPTY: AutomationSummary[] = [];

// Groups need every visible Automation at once. The server caps a page at 100.
const LANDING_PAGE_SIZE = "100";

// Groups set the order and show every Automation, so the page reads only
// the filters it shows. Old scope, sort, and page links fall back to all.
const LANDING_FILTERS = [
  "q",
  "type",
  "state",
  "creator",
  "destination",
] as const;

type AutomationGroup = {
  automations: AutomationSummary[];
  collapsed?: boolean;
  key: string;
  label: string;
};

/**
 * Landing page for Automations: problems first, then what runs, then what
 * is stopped. Each row shows recent runs and the next run, so the page
 * answers "is my work healthy" without opening each Automation.
 */
export function AutomationsPage(props: { enabled: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useDebouncedSearchParam("q");
  // Ignore only invalid URL values. One bad field must not reset other filters.
  const filters = automationListQuerySchema.parse(
    Object.fromEntries(
      LANDING_FILTERS.flatMap((key) => {
        // Zod owns this property name; it is not a Junior domain symbol.
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
        const parsed = automationListQuerySchema.shape[key].safeParse(
          searchParams.get(key) ?? undefined,
        );
        return parsed.success && parsed.data !== undefined
          ? [[key, parsed.data]]
          : [];
      }),
    ),
  );
  const request = new URLSearchParams(
    Object.entries({ ...filters, pageSize: LANDING_PAGE_SIZE }).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  const query = useAutomationsData(props.enabled, request.toString());
  const setFilter = (key: string, value: string) => {
    // Consecutive control events can precede the router's next render.
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams(window.location.search);
    for (const key of LANDING_FILTERS) if (key !== "q") next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const automations = query.data?.automations ?? EMPTY;
  const groups = groupAutomations(automations);
  const loading = !query.data && !query.error;
  // The Automation page keeps the list query, so its back link restores it.
  const pagePath = (id: string) =>
    pathWithSearch(automationPath(id), location.search);

  return (
    <>
      <PageHeader title="Automations" />
      <FilterToolbar
        filters={{
          active: activeAutomationFilters({ data: query.data, filters }),
          onRemove: (key) => setFilter(key, ""),
          onToggle: () => setFiltersOpen((open) => !open),
          open: filtersOpen,
        }}
        search={{
          label: "Search automations",
          onChange: setSearchText,
          placeholder: "Search automations",
          value: searchText,
        }}
      />
      <FilteredList
        filters={
          filtersOpen ? (
            <AutomationFilterPanel
              data={query.data}
              filters={filters}
              onChange={setFilter}
              onClear={clearFilters}
              onClose={() => setFiltersOpen(false)}
            />
          ) : null
        }
      >
        {loading ? (
          <PageContentSkeleton label="Loading automations" variant="list" />
        ) : null}
        {query.error ? (
          <InlineError>
            Automations could not be loaded.{" "}
            <Button onClick={() => void query.refetch()}>Try again</Button>
          </InlineError>
        ) : null}
        {query.data && automations.length === 0 ? (
          <Card padding="md">
            <p className="m-0 text-sm text-dashboard-text-muted">
              {LANDING_FILTERS.some((key) => searchParams.has(key))
                ? "No automations matched these filters."
                : "No automations yet. Ask Junior in Slack to do something on a schedule or when something happens."}
            </p>
          </Card>
        ) : null}
        {query.isFetching && query.data ? (
          <span className="sr-only" role="status">
            Updating results…
          </span>
        ) : null}
        {groups.map((group) => (
          <AutomationGroupSection
            group={group}
            key={group.key}
            onSelect={(id) => navigate(pagePath(id))}
            pagePath={pagePath}
          />
        ))}
        {query.data && query.data.total > automations.length ? (
          <p className="m-0 text-xs text-dashboard-text-muted">
            Showing {automations.length} of {query.data.total}. Search or filter
            to find the rest.
          </p>
        ) : null}
      </FilteredList>
    </>
  );
}

/**
 * Group by what needs a person, then by what still runs. Every group uses
 * one order, latest run first, so the "Ran" times read top to bottom.
 */
function groupAutomations(automations: AutomationSummary[]): AutomationGroup[] {
  const sorted = [...automations].sort(byLatestRun);
  const attention = sorted.filter(
    (automation) =>
      automation.status !== "completed" && automationNeedsAttention(automation),
  );
  const rest = sorted.filter((automation) => !attention.includes(automation));
  const groups: AutomationGroup[] = [
    { automations: attention, key: "attention", label: "Needs attention" },
    {
      automations: rest.filter((automation) => automation.status === "active"),
      key: "active",
      label: "Active",
    },
    {
      automations: rest.filter((automation) => automation.status === "paused"),
      collapsed: true,
      key: "paused",
      label: "Paused",
    },
    {
      automations: rest.filter(
        (automation) => automation.status === "completed",
      ),
      collapsed: true,
      key: "completed",
      label: "Completed",
    },
  ];
  return groups.filter((group) => group.automations.length > 0);
}

/** Latest run first. Automations that never ran follow, newest first. */
function byLatestRun(a: AutomationSummary, b: AutomationSummary): number {
  return (
    (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.title.localeCompare(b.title)
  );
}

function AutomationGroupSection(props: {
  group: AutomationGroup;
  onSelect(id: string): void;
  pagePath(id: string): string;
}) {
  const { group } = props;
  const [open, setOpen] = useState(!group.collapsed);
  const rows = (
    <Card>
      <div role="list">
        {group.automations.map((automation) => (
          <AutomationRow
            automation={automation}
            key={`${automation.kind}:${automation.id}`}
            onSelect={() => props.onSelect(automation.id)}
            to={props.pagePath(automation.id)}
          />
        ))}
      </div>
    </Card>
  );
  const heading = (
    <>
      {group.label}
      <span className="ml-2 tabular-nums text-dashboard-text-faint">
        {group.automations.length}
      </span>
    </>
  );
  if (!group.collapsed) {
    return (
      <section aria-label={group.label} className="grid gap-2.5">
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          {heading}
        </h3>
        {rows}
      </section>
    );
  }
  return (
    <Collapsible
      aria-label={group.label}
      className="grid gap-2.5"
      onOpenChange={setOpen}
      open={open}
      render={<section />}
    >
      <h3 className="m-0">
        <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-0 text-xs font-medium text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus">
          <ChevronRight
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-90")}
            size={14}
          />
          {heading}
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent>{rows}</CollapsibleContent>
    </Collapsible>
  );
}
