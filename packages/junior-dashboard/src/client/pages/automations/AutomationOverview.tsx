/**
 * Read view of one Automation. The sections match the editor, so edit mode
 * changes the same rows in place. The side column holds status and activity.
 */
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { AutomationSummary } from "@sentry/junior/api/schema";

import {
  useAutomationExecutionsData,
  useAutomationVersionsData,
} from "../../api";
import {
  selectTimeSeries,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { TranscriptText } from "../../conversations/TranscriptText";
import { automationPath, formatCostSummary, peoplePath } from "../../format";
import { pathWithSearch } from "../../searchParams";
import { dashboardInlineLinkClass } from "../../styles";
import { AutomationFormSection } from "./AutomationFormSection";
import { AutomationOutcomeList } from "./AutomationOutcomeFields";
import { AutomationRecentRuns } from "./AutomationRecentRuns";
import { AutomationAttention, AutomationStatus } from "./AutomationStatus";
import { TriggerFilters } from "./TriggerFilters";
import {
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";

/** Settings on the left; status, activity, and ownership on the right. */
export function AutomationOverview(props: {
  automation: AutomationSummary;
  range: TimeRangeDays;
}) {
  const { automation } = props;
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-10">
      <div className="grid min-w-0 content-start gap-6">
        <AutomationAttention automation={automation} />
        <AutomationSettings automation={automation} />
        <Card padding="sm">
          <AutomationRecentRuns automation={automation} />
        </Card>
        {/* On small screens, status leads and About follows the settings. */}
        <div className="lg:hidden">
          <AutomationAbout automation={automation} />
        </div>
      </div>
      <aside
        aria-label="Automation status"
        className="grid min-w-0 content-start gap-3 max-lg:row-start-1"
      >
        <RailCard title="Status">
          <AutomationStatus automation={automation} />
        </RailCard>
        <AutomationActivity automation={automation} range={props.range} />
        <div className="max-lg:hidden">
          <AutomationAbout automation={automation} />
        </div>
      </aside>
    </div>
  );
}

/** Saved settings, in the same sections and order as the editor. */
function AutomationSettings(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const creator = automation.ownedByViewer ? "you" : automation.createdBy;
  return (
    <div className="min-w-0 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
      <AutomationFormSection title="What to do">
        <div className="text-base leading-relaxed [overflow-wrap:anywhere]">
          <TranscriptText
            mentions={automation.mentions ?? []}
            text={automation.instruction}
          />
        </div>
      </AutomationFormSection>
      <AutomationFormSection title="When to run">
        {automation.kind === "scheduled" ? (
          <p className="m-0 text-sm">{automationScheduleLabel(automation)}</p>
        ) : (
          <div className="grid gap-1 text-sm">
            <p className="m-0 break-words">{automation.resource}</p>
            <p className="m-0 break-words text-dashboard-text-muted">
              {automation.trigger.events.join(", ")}
            </p>
            <TriggerFilters filters={automation.trigger.filters} />
          </div>
        )}
      </AutomationFormSection>
      <AutomationFormSection title="Where results go">
        <AutomationOutcomeList
          outcomes={automation.outcomes}
          destination={automation.destination}
        />
      </AutomationFormSection>
      <AutomationFormSection title="Credentials">
        <p className="m-0 text-sm">
          {automation.credentialMode === "creator"
            ? `Uses accounts connected by ${creator}.`
            : "System credentials only. Junior does not use anyone’s connected accounts."}
        </p>
      </AutomationFormSection>
    </div>
  );
}

/** Runs, problems, and spend in the selected range. */
function AutomationActivity(props: {
  automation: AutomationSummary;
  range: TimeRangeDays;
}) {
  const { automation, range } = props;
  // AutomationRecentRuns reads the same query, so this adds no request.
  const executions = useAutomationExecutionsData(true, automation.id);
  const problems = executions.data
    ? selectTimeSeries({
        days: executions.data.executionDays,
        hours: executions.data.executionHours,
        sixHours: executions.data.executionSixHours,
        range,
      }).reduce(
        (total, bucket) => ({
          blocked: total.blocked + bucket.blocked,
          failed: total.failed + bucket.failed,
        }),
        { blocked: 0, failed: 0 },
      )
    : undefined;
  return (
    <RailCard title={range === 1 ? "Last 24 hours" : `Last ${range} days`}>
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
        <RailMetric label="Runs" value={automation.runs[range]} />
        <RailMetric
          label="Spend"
          value={formatCostSummary({ total: automation.costUsd[range] })}
        />
        <RailMetric label="Failed" value={problems?.failed ?? "—"} />
        <RailMetric label="Blocked" value={problems?.blocked ?? "—"} />
      </dl>
    </RailCard>
  );
}

/** Who owns the Automation, where it lives, and which version is active. */
function AutomationAbout(props: { automation: AutomationSummary }) {
  const { automation } = props;
  const location = useLocation();
  const versions = useAutomationVersionsData(true, automation.id);
  const activeVersion = versions.data?.activeVersion;
  return (
    <RailCard title="About">
      <dl className="m-0 grid gap-3 text-sm">
        <RailFact label="Created by">
          {automation.createdByEmail ? (
            <Link
              className={dashboardInlineLinkClass}
              to={peoplePath(automation.createdByEmail)}
            >
              {automation.ownedByViewer ? "You" : automation.createdBy}
            </Link>
          ) : automation.ownedByViewer ? (
            "You"
          ) : (
            automation.createdBy
          )}
        </RailFact>
        <RailFact label="Created">
          {formatAutomationRunTime(automation.createdAt)}
        </RailFact>
        <RailFact label="Destination">
          {automation.destination.label} ·{" "}
          {automation.destination.visibility === "private"
            ? "private"
            : "public"}
        </RailFact>
        <RailFact label="Version">
          <Link
            className={dashboardInlineLinkClass}
            to={pathWithSearch(
              automationPath(automation.id, "versions"),
              location.search,
            )}
          >
            {activeVersion ? `Version ${activeVersion}` : "Version history"}
          </Link>
        </RailFact>
      </dl>
      {automation.ownedByViewer ? null : (
        <p className="mt-3 mb-0 text-xs leading-relaxed text-dashboard-text-muted">
          {automation.destination.visibility === "private"
            ? null
            : "You can edit its settings because it is in a public channel. "}
          Only {automation.createdBy} can pause, resume, or delete it, change
          where results go, or turn on their connected accounts.
        </p>
      )}
    </RailCard>
  );
}

function RailCard(props: { children: ReactNode; title: string }) {
  return (
    <Card as="section" padding="sm">
      <h2 className="m-0 mb-3 font-sans text-xs font-medium text-dashboard-text-muted">
        {props.title}
      </h2>
      {props.children}
    </Card>
  );
}

function RailMetric(props: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 mt-0.5 font-display text-xl font-light tabular-nums text-dashboard-text">
        {props.value}
      </dd>
    </div>
  );
}

function RailFact(props: { children: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words">{props.children}</dd>
    </div>
  );
}
