/**
 * One Automation page. Overview, Runs, and Versions are tabs under one header.
 * Edit mode replaces the Overview read view in place.
 */
import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Link,
  matchPath,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { eventTriggerText } from "@sentry/junior-plugin-api";

import { useAutomationData } from "../../api";
import { Button } from "../../components/ui/button";
import { FormNotice } from "../../components/FormNotice";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { automationPath, type AutomationTab } from "../../format";
import { DashboardApiError, fetchDashboardJson } from "../../http";
import { pathWithSearch, useSearchParamEnum } from "../../searchParams";
import { AutomationActions } from "./AutomationActions";
import { AutomationDeleteDialog } from "./AutomationDeleteDialog";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationEditorLoading } from "./AutomationEditorLoading";
import { AutomationOverview } from "./AutomationOverview";
import { AUTOMATION_RUN_PARAM } from "./AutomationRunDetails";
import {
  AutomationRunsTab,
  AUTOMATION_RESULT_PARAM,
} from "./AutomationRunsTab";
import { AutomationStateChip } from "./AutomationStatus";
import {
  AUTOMATION_VERSION_PARAM,
  AutomationVersionsTab,
} from "./AutomationVersionsTab";

const RANGE_OPTIONS = ["1", "7", "30", "90"] as const;

/** Search params that belong to one tab. The list link drops them. */
const PAGE_PARAMS = [
  AUTOMATION_RESULT_PARAM,
  AUTOMATION_RUN_PARAM,
  AUTOMATION_VERSION_PARAM,
];

const TAB_LABELS: Record<AutomationTab, string> = {
  edit: "Edit",
  overview: "Overview",
  runs: "Runs",
  versions: "Versions",
};

/** Render one Automation tab, or edit mode, under the shared header and tabs. */
export function AutomationPage(props: {
  enabled: boolean;
  tab: AutomationTab;
}) {
  const { automationId } = useParams();
  const location = useLocation();
  const summary = useAutomationData(props.enabled, automationId);
  const [rangeParam, setRangeParam] = useSearchParamEnum(
    "range",
    "30",
    RANGE_OPTIONS,
  );
  const range = Number(rangeParam) as TimeRangeDays;
  if (!automationId) return <Navigate replace to="/automations/list" />;
  const listSearch = new URLSearchParams(location.search);
  for (const param of PAGE_PARAMS) listSearch.delete(param);
  const listPath = pathWithSearch("/automations/list", listSearch);
  const automation = summary.data;
  const tabs = (["overview", "runs", "versions"] as const).map((tab) => ({
    label: TAB_LABELS[tab],
    to: automationPath(automationId, tab),
    // Edit mode is part of Overview.
    isActive: (pathname: string) =>
      tab === "overview"
        ? Boolean(
            matchPath("/automations/:automationId", pathname) ||
            matchPath("/automations/:automationId/edit", pathname),
          )
        : Boolean(matchPath(`/automations/:automationId/${tab}`, pathname)),
  }));
  const runsFrame = props.tab === "runs" && Boolean(automation);
  return (
    <SecondaryNavigation
      ariaLabel="Automation navigation"
      className={
        runsFrame
          ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
          : undefined
      }
      items={tabs}
    >
      {automation ? (
        <AutomationPageContent
          automation={automation}
          listPath={listPath}
          onRangeChange={(value) =>
            setRangeParam(String(value) as (typeof RANGE_OPTIONS)[number])
          }
          range={range}
          tab={props.tab}
        />
      ) : (
        <PageLayout>
          <BackLink to={listPath} />
          <PageHeader
            description="Settings, runs, and versions for one automation."
            title="Automation"
          />
          {summary.error ? (
            <FormNotice tone="error" title="Automation could not be loaded.">
              {summary.error instanceof DashboardApiError &&
              summary.error.status === 404
                ? "This automation was not found or is not visible to you."
                : "Try again."}{" "}
              <Button onClick={() => void summary.refetch()}>Try again</Button>
            </FormNotice>
          ) : (
            <PageContentSkeleton label="Loading automation" variant="list" />
          )}
        </PageLayout>
      )}
    </SecondaryNavigation>
  );
}

function AutomationPageContent(props: {
  automation: AutomationSummary;
  listPath: string;
  onRangeChange(value: TimeRangeDays): void;
  range: TimeRangeDays;
  tab: AutomationTab;
}) {
  const { automation, tab } = props;
  const location = useLocation();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const deleteSource = useRef<HTMLButtonElement | null>(null);
  const completed = automation.status === "completed";
  // Completed Automations cannot change, so edit mode shows the read view.
  if (tab === "edit" && completed) {
    return (
      <Navigate
        replace
        to={pathWithSearch(automationPath(automation.id), location.search)}
      />
    );
  }
  const header = (
    <>
      <BackLink to={props.listPath} />
      <PageHeader
        actions={
          tab === "edit" ? undefined : (
            <div className="flex flex-wrap items-start gap-2 md:justify-end">
              {tab === "overview" || tab === "runs" ? (
                <TimeRangeSelector
                  onChange={props.onRangeChange}
                  value={props.range}
                />
              ) : null}
              <AutomationActions
                automation={automation}
                editPath={pathWithSearch(
                  automationPath(automation.id, "edit"),
                  location.search,
                )}
                onDelete={(source) => {
                  deleteSource.current = source;
                  setDeleting(true);
                }}
              />
            </div>
          )
        }
        description={<AutomationHeaderLine automation={automation} />}
        documentTitle={
          tab === "overview"
            ? automation.title
            : `${automation.title} · ${TAB_LABELS[tab]}`
        }
        title={automation.title}
      />
    </>
  );
  const dialog = deleting ? (
    <AutomationDeleteDialog
      automation={automation}
      onClose={() => setDeleting(false)}
      onDeleted={() => {
        deleteSource.current = null;
        navigate(props.listPath);
      }}
      returnFocus={() =>
        deleteSource.current?.isConnected ? deleteSource.current : false
      }
    />
  ) : null;
  if (tab === "runs") {
    return (
      <>
        <AutomationRunsTab
          automation={automation}
          header={header}
          range={props.range}
        />
        {dialog}
      </>
    );
  }
  return (
    <PageLayout>
      {header}
      {tab === "overview" ? (
        <AutomationOverview automation={automation} range={props.range} />
      ) : null}
      {tab === "edit" ? <AutomationEditMode automation={automation} /> : null}
      {tab === "versions" ? (
        <AutomationVersionsTab automation={automation} />
      ) : null}
      {dialog}
    </PageLayout>
  );
}

/** Load exact editable values, then edit the Overview sections in place. */
function AutomationEditMode(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const location = useLocation();
  const edit = useQuery({
    queryKey: ["dashboard", "automations", "edit", automation.id],
    retry: false,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationEditSchema,
        `/api/automations/${encodeURIComponent(automation.id)}/edit`,
        signal,
      ),
  });
  if (edit.error && !edit.data) {
    return (
      <FormNotice tone="error" title="Automation could not be loaded.">
        It may no longer be available, or you may not have access.{" "}
        <Button onClick={() => void edit.refetch()}>Try again</Button>
      </FormNotice>
    );
  }
  if (!edit.data) return <AutomationEditorLoading />;
  return (
    <AutomationEditor
      key={automation.id}
      automation={edit.data}
      summary={automation}
      returnPath={pathWithSearch(
        automationPath(automation.id),
        location.search,
      )}
    />
  );
}

/** State, trigger, Destination, and creator in one line under the title. */
function AutomationHeaderLine(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const trigger =
    automation.kind === "scheduled"
      ? automation.schedule
      : eventTriggerText(automation.resource, automation.trigger);
  const parts: ReactNode[] = [
    trigger,
    automation.destination.label,
    `Created by ${automation.ownedByViewer ? "you" : automation.createdBy}`,
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <AutomationStateChip automation={automation} />
      {parts.map((part, index) => (
        <span className="min-w-0 break-words" key={index}>
          {index > 0 ? (
            <span aria-hidden="true" className="mr-2 opacity-45">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function BackLink(props: { to: string }) {
  return (
    <Link
      className="flex w-fit items-center gap-2 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
      to={props.to}
    >
      <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
      All automations
    </Link>
  );
}
