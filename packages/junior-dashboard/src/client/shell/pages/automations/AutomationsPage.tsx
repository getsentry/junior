import { memo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  automationListQuerySchema,
  type AutomationListItem,
  type InboxItemPayload,
} from "@sentry/junior/api/schema";
import { useAutomationPagesData } from "../../../api";
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
import { InboxAutomationRow } from "../../../inbox/InboxAutomationRow";
import { useInboxData } from "../../../inbox/inboxData";
import { InboxEmptyState, InboxSection } from "../../../inbox/InboxSection";
import {
  DOCK_GUTTER,
  InboxFocusProvider,
  InboxPreviewGate,
  useCollapseOutside,
  useInboxFocus,
} from "../../../inbox/inboxFocus";
import { timeGroups } from "../../../inbox/inboxModel";
import {
  scrollPages,
  useAutomationAttentionData,
} from "../../../inbox/inboxQueries";
import { PageEnd } from "../../../inbox/PageEnd";
import { useInboxItemAction, useInboxItemsData } from "../../../inbox/queries";
import {
  RowDismissButton,
  RowSnoozeButton,
} from "../../../inbox/RowSnoozeDismiss";
import { AutomationRow } from "./AutomationRow";
import { AutomationScopeTabs, automationScopeOf } from "./AutomationScopeTabs";
import { NAV_PAGES } from "../../../navPages";

/** An Automation in To do, with its alert. */
type TodoAlert = { alert: InboxItemPayload; automation: AutomationListItem };

const EMPTY: AutomationListItem[] = [];
const NO_ALERTS: TodoAlert[] = [];

/**
 * The Automations whose open alert waits on the viewer, in the Inbox's
 * order. An alert waits for its Automation to load, and shows in the other
 * groups until then.
 */
function todoAlerts(
  alerts: readonly InboxItemPayload[],
  automations: readonly AutomationListItem[],
): TodoAlert[] {
  const byId = new Map(
    automations.map((automation) => [automation.id, automation]),
  );
  return alerts.flatMap((alert) => {
    const automation =
      alert.owner.kind === "automation" ? byId.get(alert.owner.id) : undefined;
    return automation ? [{ alert, automation }] : [];
  });
}

// One page of rows. More load as the list scrolls.
const LANDING_PAGE_SIZE = "50";

// The list orders by latest activity, so the page reads only the filters
// it shows and the scope. Old search, sort, and page links fall back to
// the default; the command palette finds an Automation by name.
const LANDING_FILTERS = ["type", "state", "creator", "destination"] as const;

/**
 * Landing page for Automations, in the Inbox's style: To do first, the
 * viewer's Automations whose alerts wait in the Inbox's To do, then
 * the rest by latest run, grouped as Today, This week, and Earlier. Mine
 * shows the viewer's own; All shows every visible one. Each card shows
 * recent runs and the next run, and opens in place for more, so the page
 * answers "is my work healthy" without opening each Automation.
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
  const scope = automationScopeOf(searchParams);
  const request = new URLSearchParams(
    Object.entries({ ...filters, pageSize: LANDING_PAGE_SIZE, scope }).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  const pages = useAutomationPagesData(props.enabled, request.toString());
  const { query } = pages;
  const more = scrollPages(query);
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
  // The first page carries the filter options and counts.
  const list = pages.first;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtered = LANDING_FILTERS.some((key) => searchParams.has(key));
  // To do holds the viewer's open alerts that are not snoozed, as the
  // Inbox's To do does. Filters narrow the whole list instead.
  const inbox = useInboxData();
  const alerts = useInboxItemsData({
    automationAlerts: true,
    enabled: props.enabled && !filtered,
    forViewer: true,
    sort: "waiting",
  });
  const attention = useAutomationAttentionData(props.enabled);
  const todo = filtered
    ? NO_ALERTS
    : todoAlerts(
        alerts.items.filter(
          (alert) => alert.status === "open" && !inbox.snoozes.hides(alert),
        ),
        attention.data?.automations ?? EMPTY,
      );
  const dismiss = useInboxItemAction({ optimistic: true });
  const automations = pages.automations;
  const loading = !list && !query.error;
  const scroll = usePaneRowScroll("automations", Boolean(list));
  // The Inbox's one pointer driver moves these cards too.
  const [expanded, setExpanded] = useState<string>();
  const focus = useInboxFocus(scroll.ref, expanded ?? "");
  useCollapseOutside(expanded ?? "", () => setExpanded(undefined));
  const toolbar = {
    active: activeAutomationFilters({ data: list, filters }),
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
            <AutomationScopeTabs scope={scope} search={location.search} />
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to={NAV_PAGES.automationRuns.to}
            >
              {NAV_PAGES.automationRuns.label}
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
                  data={list}
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
            {list && automations.length === 0 && todo.length === 0 ? (
              <InboxEmptyState
                label={
                  filtered
                    ? "No automations matched these filters."
                    : scope === "mine"
                      ? "You have no automations yet"
                      : "No automations yet"
                }
              />
            ) : null}
            {query.isFetching && !query.isFetchingNextPage && list ? (
              <span className="sr-only" role="status">
                Updating results…
              </span>
            ) : null}
            {list ? (
              <InboxFocusProvider focus={focus.focus}>
                <InboxPreviewGate>
                  <AutomationGroups
                    automations={automations}
                    onDismiss={(alert) =>
                      dismiss.mutate({
                        body: { action: "dismiss" },
                        id: alert.id,
                      })
                    }
                    onSnooze={(alert, untilMs) =>
                      void inbox.snoozes.snoozeItem(alert, untilMs)
                    }
                    expanded={expanded}
                    onExpand={setExpanded}
                    search={location.search}
                    todo={todo}
                  />
                </InboxPreviewGate>
              </InboxFocusProvider>
            ) : null}
            {list ? (
              <PageEnd
                failed={more.failed}
                loading={more.loadingMore}
                more={more.hasMore}
                onRetry={more.retry}
                onShow={more.loadMore}
                progress={[automations.length, more.loadingMore].join()}
              />
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
  automations: AutomationListItem[];
  /** The card open in place, if any. */
  expanded?: string;
  onDismiss(alert: InboxItemPayload): void;
  onExpand(id: string | undefined): void;
  /** Snoozes the alert, as the Inbox does. */
  onSnooze(alert: InboxItemPayload, untilMs: number): void;
  search: string;
  todo: TodoAlert[];
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [snoozeId, setSnoozeId] = useState<string>();
  const todoIds = new Set(props.todo.map(({ automation }) => automation.id));
  // The server orders rows by latest activity, so groups keep its order.
  const rest = props.automations.filter(
    (automation) => !todoIds.has(automation.id),
  );
  const toggle = (key: string) =>
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  const toggleRow = (id: string) =>
    props.onExpand(props.expanded === id ? undefined : id);
  return (
    <div>
      {/* To do is the Inbox's section, so its cards open in place. */}
      <InboxSection
        collapsed={Boolean(collapsed["todo"])}
        count={props.todo.length}
        label="To do"
        onToggle={() => toggle("todo")}
      >
        {props.todo.map(({ alert, automation }) => (
          <InboxAutomationRow
            automation={automation}
            expanded={props.expanded === automation.id}
            key={automation.id}
            onToggle={() => toggleRow(automation.id)}
            rowKey={automation.id}
          >
            <RowDismissButton onClick={() => props.onDismiss(alert)} />
            <RowSnoozeButton
              onOpenChange={(open) =>
                setSnoozeId(open ? automation.id : undefined)
              }
              onSnooze={(untilMs) => {
                props.onSnooze(alert, untilMs);
                setSnoozeId(undefined);
              }}
              open={snoozeId === automation.id}
            />
          </InboxAutomationRow>
        ))}
      </InboxSection>
      {timeGroups(rest, activityAt, Date.now()).map((group) => (
        <InboxSection
          collapsed={Boolean(collapsed[group.key])}
          count={group.rows.length}
          key={group.key}
          label={group.label}
          onToggle={() => toggle(group.key)}
        >
          {group.rows.map((automation) => (
            <AutomationRow
              automation={automation}
              expanded={props.expanded === automation.id}
              key={`${automation.kind}:${automation.id}`}
              onToggle={() => toggleRow(automation.id)}
              search={props.search}
            />
          ))}
        </InboxSection>
      ))}
    </div>
  );
});

/** When the last run ended, or else when the Automation was created. */
function activityAt(automation: AutomationListItem): string {
  return automation.lastRunAt ?? automation.createdAt;
}
