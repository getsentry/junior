import type { AutomationSummary } from "@sentry/junior/api/schema";
import { eventTriggerText } from "@sentry/junior-plugin-api";
import { CalendarClock, Zap } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import { useAutomationsData } from "../../api";
import { SearchInput } from "../../components/SearchInput";
import {
  usePaneTabValue,
  type PaneNewAction,
} from "../../components/layout/PaneNav";
import {
  restoreStoredDraftText,
  takeStoredDraftText,
} from "../../conversations/ConversationComposer";
import { Skeleton } from "../../components/ui/skeleton";
import { useDebouncedValue } from "../../debouncedValue";
import { automationPath } from "../../format";
import { cn } from "../../styles";
import { automationNeedsAttention } from "./AutomationStatus";

const NEW_AUTOMATION_PROMPT = "Set up an automation that ";

/**
 * New on the Automations tab. The dashboard has no Automation form: Junior
 * sets one up from a Conversation, so New starts one with the ask typed in.
 */
export function useNewAutomationAction(): PaneNewAction {
  const navigate = useNavigate();
  return {
    label: "New automation",
    onClick() {
      const draft = takeStoredDraftText("new");
      restoreStoredDraftText(
        "new",
        draft.startsWith(NEW_AUTOMATION_PROMPT)
          ? draft
          : `${NEW_AUTOMATION_PROMPT}${draft}`,
      );
      navigate("/");
    },
  };
}

/** Where the list opens an Automation: its editor, unless it cannot change. */
export function automationSelectPath(automation: AutomationSummary): string {
  return automation.status === "completed"
    ? automationPath(automation.id)
    : automationPath(automation.id, "edit");
}

function selectedAutomationId(pathname: string): string | undefined {
  const match = pathname.match(/^\/automations\/([^/]+)/);
  const id = match?.[1];
  return id && id !== "list" && id !== "runs" ? decodeURIComponent(id) : id;
}

type Group = { key: string; label: string; rows: AutomationSummary[] };

function groupAutomations(automations: AutomationSummary[]): Group[] {
  const attention = automations.filter(automationNeedsAttention);
  const rest = automations.filter((value) => !attention.includes(value));
  return [
    { key: "attention", label: "Needs attention", rows: attention },
    {
      key: "active",
      label: "Active",
      rows: rest.filter((value) => value.status === "active"),
    },
    {
      key: "paused",
      label: "Paused and done",
      rows: rest.filter((value) => value.status !== "active"),
    },
  ].filter((group) => group.rows.length > 0);
}

function AutomationSidebarRow(props: {
  automation: AutomationSummary;
  selected: boolean;
}) {
  const { automation } = props;
  const Icon = automation.kind === "scheduled" ? CalendarClock : Zap;
  const trigger =
    automation.kind === "scheduled"
      ? automation.schedule
      : eventTriggerText(automation.resource, automation.trigger);
  const attention = automationNeedsAttention(automation);
  const quiet =
    automation.status === "paused" || automation.status === "completed";
  return (
    <li className="list-none">
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-3 py-2 font-sans no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          props.selected
            ? "bg-dashboard-accent/[0.12] text-dashboard-accent-text"
            : "text-dashboard-text hover:bg-dashboard-fill-hover",
        )}
        to={automationSelectPath(automation)}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4",
            attention
              ? "text-amber-400"
              : quiet
                ? "text-dashboard-text-faint"
                : "text-dashboard-text-muted",
          )}
          strokeWidth={1.9}
        />
        <span className="grid min-w-0 gap-0.5">
          <span
            className={cn(
              "truncate text-sm",
              quiet ? "text-dashboard-text-muted" : "font-medium",
            )}
          >
            {automation.title}
          </span>
          <span className="truncate text-xs text-dashboard-text-muted">
            {attention && automation.kind === "event"
              ? (automation.trigger.problems[0] ?? trigger)
              : automation.status === "paused"
                ? `Paused · ${trigger}`
                : trigger}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The Automations tab list: every Automation the viewer can see, grouped by
 * what needs them. A row opens its editor in the main pane. The search stays
 * while another tab shows.
 */
export function AutomationSidebarList(props: { className?: string }) {
  const { pathname } = useLocation();
  const [search, setSearch] = usePaneTabValue("automations:search");
  const q = useDebouncedValue(search.trim());
  const params = new URLSearchParams({ pageSize: "100" });
  if (q) params.set("q", q);
  const query = useAutomationsData(true, params.toString());
  const selectedId = selectedAutomationId(pathname);
  const groups = groupAutomations(query.data?.automations ?? []);
  return (
    <aside
      aria-label="Automations"
      className={cn(
        "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-dashboard-border bg-dashboard-surface-panel",
        props.className,
      )}
    >
      <div className="px-3 pt-3 pb-2">
        <SearchInput
          label="Search automations"
          onChange={setSearch}
          placeholder="Search automations…"
          value={search}
        />
      </div>
      {/* Room under the last row for the floating New button. */}
      <div className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain px-3 pb-16">
        {query.isPending ? (
          <div aria-busy="true" className="grid gap-1 pt-2" role="status">
            <span className="sr-only">Loading automations</span>
            {[0, 1, 2, 3].map((row) => (
              <div className="grid gap-1.5 py-2 pr-3 pl-10" key={row}>
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-4/5 opacity-70" />
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="m-0 px-3 py-6 text-sm text-dashboard-text-muted">
            {q ? `No automations match "${q}".` : "No automations yet."}
          </p>
        ) : (
          groups.map((group, index) => (
            <section aria-label={group.label} key={group.key}>
              <h3
                className={cn(
                  "m-0 pr-3 pb-1 pl-10 font-sans text-xs font-medium text-dashboard-text-muted",
                  index === 0 ? "pt-1" : "pt-3",
                )}
              >
                {group.label}
              </h3>
              <ul className="m-0 grid gap-0.5 p-0">
                {group.rows.map((automation) => (
                  <AutomationSidebarRow
                    automation={automation}
                    key={automation.id}
                    selected={automation.id === selectedId}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
