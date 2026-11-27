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
  type AutomationListItem,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { eventTriggerText } from "@sentry/junior-plugin-api";

import {
  automationKeys,
  useAutomationData,
  useAutomationExecutionsData,
  useAutomationVersionsData,
  useCachedAutomationListItem,
} from "../../../api";
import { Button, buttonVariants } from "../../../components/ui/button";
import { FormNotice } from "../../../components/FormNotice";
import { PageContentSkeleton } from "../../../components/PageContentSkeleton";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../../components/controls/TimeRangeSelector";
import { useRegisterMobileHeaderBack } from "../../../components/layout/DashboardChrome";
import { PageLayout } from "../../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../../components/layout/SecondaryNavigation";
import { useDocumentTitle } from "../../../documentTitle";
import { automationPath, type AutomationTab } from "../../../format";
import { DashboardApiError, fetchDashboardJson } from "../../../http";
import { pathWithSearch, useSearchParamEnum } from "../../../searchParams";
import { cn } from "../../../styles";
import { AutomationActions } from "./AutomationActions";
import { AutomationDeleteDialog } from "./AutomationDeleteDialog";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationEditorLoading } from "../../../pages/automations/AutomationEditorLoading";
import { AutomationOverview } from "../../../pages/automations/AutomationOverview";
import { AUTOMATION_RUN_PARAM } from "../../../pages/automations/AutomationRunDetails";
import {
  AutomationRunsTab,
  AUTOMATION_RESULT_PARAM,
} from "../../../pages/automations/AutomationRunsTab";
import {
  AutomationStateChip,
  automationNeedsAttention,
} from "../../../pages/automations/AutomationStatus";
import {
  AUTOMATION_VERSION_PARAM,
  AutomationVersionsTab,
} from "./AutomationVersionsTab";
import { fadeTextClass } from "../../../textFade";

const RANGE_OPTIONS = ["1", "7", "30", "90"] as const;
const RANGE_DAYS = {
  "1": 1,
  "7": 7,
  "30": 30,
  "90": 90,
} as const satisfies Record<(typeof RANGE_OPTIONS)[number], TimeRangeDays>;

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
  // Start the reads that the tab needs with the summary, not after it.
  const overview = props.tab === "overview";
  useAutomationExecutionsData(
    props.enabled && (overview || props.tab === "runs"),
    automationId,
  );
  useAutomationVersionsData(
    props.enabled && (overview || props.tab === "versions"),
    automationId,
  );
  // A row the list loaded paints the header while the summary loads.
  const listed = useCachedAutomationListItem(automationId);
  const [rangeParam, setRangeParam] = useSearchParamEnum(
    "range",
    "30",
    RANGE_OPTIONS,
  );
  const range = RANGE_DAYS[rangeParam];
  if (!automationId) return <Navigate replace to="/automations" />;
  const listSearch = new URLSearchParams(location.search);
  for (const param of PAGE_PARAMS) listSearch.delete(param);
  const listPath = pathWithSearch("/automations", listSearch);
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
            setRangeParam(
              RANGE_OPTIONS.find((option) => RANGE_DAYS[option] === value) ??
                "30",
            )
          }
          range={range}
          tab={props.tab}
        />
      ) : (
        <PageLayout>
          <AutomationHeader
            description={
              listed && !summary.error ? (
                <AutomationHeaderLine automation={listed} />
              ) : (
                "Settings, runs, and versions for one automation."
              )
            }
            listPath={listPath}
            title={listed?.title ?? "Automation"}
          />
          {summary.error ? (
            <FormNotice tone="error" title="Automation could not be loaded.">
              {summary.error instanceof DashboardApiError &&
              summary.error.status === 404
                ? "This automation was not found or is not visible to you."
                : "Try again."}{" "}
              <Button variant="outline" onClick={() => void summary.refetch()}>
                Try again
              </Button>
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
  const editPath = pathWithSearch(
    automationPath(automation.id, "edit"),
    location.search,
  );
  const header = (
    <AutomationHeader
      actions={
        tab === "edit" ? undefined : (
          <div className="flex flex-wrap items-center gap-2">
            {tab === "runs" ? (
              <TimeRangeSelector
                onChange={props.onRangeChange}
                value={props.range}
              />
            ) : null}
            <AutomationActions
              automation={automation}
              editPath={editPath}
              editVariant={
                tab === "overview" && automationNeedsAttention(automation)
                  ? "outline"
                  : "default"
              }
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
      listPath={props.listPath}
      title={automation.title}
    />
  );
  const dialog = deleting ? (
    <AutomationDeleteDialog
      automation={automation}
      onClose={() => setDeleting(false)}
      onDeleted={() => {
        deleteSource.current = null;
        void navigate(props.listPath);
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
        <AutomationOverview automation={automation} editPath={editPath} />
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
    queryKey: automationKeys.edit(automation.id),
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
        <Button variant="outline" onClick={() => void edit.refetch()}>
          Try again
        </Button>
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
function AutomationHeaderLine(props: { automation: AutomationListItem }) {
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
  // Each part starts with its separator. The negative margin and the clip
  // hide the separator of any part that starts a line.
  return (
    <span className="block min-w-0 overflow-hidden">
      <span className="-ml-4 flex min-w-0 flex-wrap items-center gap-y-1">
        <span className="flex items-center">
          <span aria-hidden="true" className="inline-block w-4" />
          <AutomationStateChip automation={automation} />
        </span>
        {parts.map((part, index) => (
          <span className="min-w-0 break-words" key={index}>
            <span
              aria-hidden="true"
              className={cn(
                "inline-block w-4 text-center opacity-45",
                index === 0 && "invisible",
              )}
            >
              ·
            </span>
            {part}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The Automation's header, in the header bar's style: the way back, the
 * title, and the actions on one row, then what it does and its state.
 */
function AutomationHeader(props: {
  actions?: ReactNode;
  description: ReactNode;
  documentTitle?: string;
  listPath: string;
  title: string;
}) {
  useDocumentTitle(props.documentTitle ?? props.title);
  const navigate = useNavigate();
  // A phone shows the way back in the shell header, as other pages do.
  useRegisterMobileHeaderBack(
    "Back to automations",
    () => void navigate(props.listPath),
    "Automation",
  );
  return (
    <header className="grid min-w-0 gap-1 border-b border-dashboard-border-subtle pb-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <Link
          aria-label="Back to automations"
          className={cn(
            buttonVariants({ size: "icon", variant: "ghost" }),
            "max-md:hidden",
          )}
          to={props.listPath}
        >
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
        </Link>
        <h1
          className={cn(
            fadeTextClass,
            "m-0 flex-1 font-display text-lg font-medium tracking-[-0.01em] text-dashboard-text max-md:basis-full",
          )}
        >
          {props.title}
        </h1>
        {props.actions}
      </div>
      <div className="min-w-0 pl-11 text-sm text-dashboard-text-muted max-md:pl-0">
        {props.description}
      </div>
    </header>
  );
}
