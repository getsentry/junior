import { memo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  automationListQuerySchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { useAutomationsData } from "../../../api";
import { Button, buttonVariants } from "../../../components/ui/button";
import {
  ActiveFilterChips,
  FilterToggle,
} from "../../components/filters/FilterToolbar";
import {
  activeAutomationFilters,
  AutomationFilterPanel,
} from "../../../pages/automations/AutomationFilters";
import { InlineError } from "../../../components/InlineError";
import { FilteredList } from "../../../components/filters/FilterPanel";
import { PageContentSkeleton } from "../../../components/PageContentSkeleton";
import { HeaderBar } from "../../../components/layout/HeaderBar";
import { usePaneRowScroll } from "../../../components/layout/PaneNav";
import { useDocumentTitle } from "../../../documentTitle";
import { automationPath } from "../../../format";
import { COMMAND_PALETTE_SHORTCUT } from "../../components/CommandPalette";
import { InboxAutomationRow } from "../../../review-desk/InboxAutomationRow";
import type { useAutomationAlerts } from "../../../review-desk/automationAlerts";
import { useInboxData } from "../../../review-desk/inboxData";
import {
  InboxEmptyState,
  InboxSection,
} from "../../../review-desk/InboxSection";
import {
  DOCK_GUTTER,
  InboxFocusProvider,
  InboxPreviewGate,
  useCollapseOutside,
  useInboxFocus,
} from "../../../review-desk/inboxFocus";
import { pathWithSearch } from "../../../searchParams";
import { AutomationRow } from "./AutomationRow";

const EMPTY: AutomationSummary[] = [];

// Groups need every visible Automation at once. The server caps a page at 100.
const LANDING_PAGE_SIZE = "100";

// Groups set the order and show every Automation, so the page reads only
// the filters it shows. Old search, scope, sort, and page links fall back
// to all; the command palette finds an Automation by name.
const LANDING_FILTERS = ["type", "state", "creator", "destination"] as const;

/**
 * Landing page for Automations, in the Inbox's style: To do first, the
 * viewer's Automations that need attention as the Inbox lists them, then
 * what runs, then what is stopped. Each card shows recent runs and the next
 * run, so the page answers "is my work healthy" without opening each
 * Automation.
 */
export function AutomationsPage(props: { enabled: boolean }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  useDocumentTitle("Automations");
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
    for (const key of LANDING_FILTERS) next.delete(key);
    setSearchParams(next, { replace: true });
  };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtered = LANDING_FILTERS.some((key) => searchParams.has(key));
  // To do is the Inbox's own list, so its count matches the Automations
  // row. Filters narrow the whole list instead.
  const inbox = useInboxData();
  const todo = filtered ? EMPTY : inbox.todoAutomations;
  const automations = query.data?.automations ?? EMPTY;
  const loading = !query.data && !query.error;
  const scroll = usePaneRowScroll("automations", Boolean(query.data));
  // The Inbox's one pointer driver moves these cards too.
  const [expanded, setExpanded] = useState<string>();
  const focus = useInboxFocus(scroll.ref, expanded ?? "");
  useCollapseOutside(expanded ?? "", () => setExpanded(undefined));
  const toolbar = {
    active: activeAutomationFilters({ data: query.data, filters }),
    onRemove: (key: string) => setFilter(key, ""),
    onToggle: () => setFiltersOpen((open) => !open),
    open: filtersOpen,
  };

  return (
    <section
      aria-label="Automations"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg"
    >
      <HeaderBar
        actions={
          <>
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to="/automations/runs"
            >
              Runs
            </Link>
            <FilterToggle filters={toolbar} />
          </>
        }
        title="Automations"
      />
      <div
        className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
        {...focus.handlers}
      >
        <div
          className="mx-auto w-full max-w-6xl pt-3 pb-16"
          style={{ paddingInline: DOCK_GUTTER }}
        >
          <FilteredList
            toolbar={<ActiveFilterChips filters={toolbar} />}
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
                <Button variant="outline" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              </InlineError>
            ) : null}
            {query.data && automations.length === 0 && todo.length === 0 ? (
              <InboxEmptyState
                label={
                  filtered
                    ? "No automations matched these filters."
                    : "No automations yet"
                }
              />
            ) : null}
            {query.isFetching && query.data ? (
              <span className="sr-only" role="status">
                Updating results…
              </span>
            ) : null}
            {query.data ? (
              <InboxFocusProvider focus={focus.focus}>
                <InboxPreviewGate>
                  <AutomationGroups
                    alerts={inbox.alerts}
                    automations={automations}
                    expanded={expanded}
                    onExpand={setExpanded}
                    search={location.search}
                    todo={todo}
                  />
                </InboxPreviewGate>
              </InboxFocusProvider>
            ) : null}
            {query.data && query.data.total > automations.length ? (
              <p className="m-0 text-xs text-dashboard-text-muted">
                Showing {automations.length} of {query.data.total}. Filter, or
                search with {COMMAND_PALETTE_SHORTCUT}, to find the rest.
              </p>
            ) : null}
          </FilteredList>
        </div>
      </div>
    </section>
  );
}

/**
 * A row has up to 20 run tooltips, so a page re-render, such as opening the
 * filter panel, must not re-render them. Rows re-render only when the
 * results or the URL change.
 */
const AutomationGroups = memo(function AutomationGroups(props: {
  /** Puts To do alerts away, as the Inbox does. */
  alerts: ReturnType<typeof useAutomationAlerts>;
  automations: AutomationSummary[];
  /** The To do card open in place, if any. */
  expanded?: string;
  onExpand(id: string | undefined): void;
  search: string;
  todo: AutomationSummary[];
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    completed: true,
    paused: true,
  });
  const [snoozeId, setSnoozeId] = useState<string>();
  // The Automation page keeps the list query, so its back link restores it.
  const pagePath = (id: string) =>
    pathWithSearch(automationPath(id), props.search);
  const todoIds = new Set(props.todo.map((automation) => automation.id));
  const sorted = props.automations
    .filter((automation) => !todoIds.has(automation.id))
    .sort(byLatestRun);
  const toggle = (key: string) =>
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  return (
    <div>
      {/* To do is the Inbox's section, so its cards open in place. */}
      <InboxSection
        collapsed={Boolean(collapsed["todo"])}
        count={props.todo.length}
        label="To do"
        onToggle={() => toggle("todo")}
      >
        {props.todo.map((automation) => (
          <InboxAutomationRow
            automation={automation}
            expanded={props.expanded === automation.id}
            key={automation.id}
            onToggle={() =>
              props.onExpand(
                props.expanded === automation.id ? undefined : automation.id,
              )
            }
            putAway={{
              menuOpen: snoozeId === automation.id,
              onDismiss: () => props.alerts.dismiss(automation),
              onMenu: (open) => setSnoozeId(open ? automation.id : undefined),
              onSnooze: (choice) => {
                props.alerts.snooze(automation, choice);
                setSnoozeId(undefined);
              },
            }}
            rowKey={automation.id}
          />
        ))}
      </InboxSection>
      {GROUPS.map((group) => {
        const rows = sorted.filter((automation) =>
          group.statuses.includes(automation.status),
        );
        return (
          <InboxSection
            collapsed={Boolean(collapsed[group.key])}
            count={rows.length}
            key={group.key}
            label={group.label}
            onToggle={() => toggle(group.key)}
          >
            {rows.map((automation) => (
              <AutomationRow
                automation={automation}
                key={`${automation.kind}:${automation.id}`}
                onSelect={() => navigate(pagePath(automation.id))}
                to={pagePath(automation.id)}
              />
            ))}
          </InboxSection>
        );
      })}
    </div>
  );
});

/**
 * The sections after To do. A blocked Automation still runs once fixed, so
 * it stays with the active ones and shows its problem.
 */
const GROUPS: readonly {
  key: string;
  label: string;
  statuses: readonly AutomationSummary["status"][];
}[] = [
  { key: "active", label: "Active", statuses: ["active", "blocked"] },
  { key: "paused", label: "Paused", statuses: ["paused"] },
  { key: "completed", label: "Completed", statuses: ["completed"] },
];

/** Latest run first. Automations that never ran follow, newest first. */
function byLatestRun(a: AutomationSummary, b: AutomationSummary): number {
  return (
    (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.title.localeCompare(b.title)
  );
}
