import type { CodePersonReport } from "@sentry/junior/api/schema";
import { Coins, GitPullRequest, LibraryBig, Timer } from "lucide-react";
import { formatDuration } from "../../components/Duration";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatCostSummary } from "../../format";
import { CodeActivityChart } from "../code/CodeActivityChart";

function mergeRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function medianMergeTime(value: number | undefined): string {
  return formatDuration(value) || "—";
}

function costUsd(value: number | undefined): string {
  return formatCostSummary(value === undefined ? undefined : { total: value }) || "—";
}

function hasCodeActivity(report: CodePersonReport): boolean {
  const summary = report.summary;
  return (
    summary.created + summary.merged + summary.closed > 0 ||
    (summary.costUsd ?? 0) > 0 ||
    report.activityDays.some(
      (day) => day.created + day.merged + day.closed > 0,
    )
  );
}

/** Render person-scoped native code change activity. */
export function ProfileCodeActivity(props: {
  range: TimeRangeDays;
  report: CodePersonReport;
}) {
  if (!hasCodeActivity(props.report)) return null;
  const summary = props.report.summary;
  return (
    <section aria-labelledby="profile-code-title" className="grid gap-4">
      <SectionIntro id="profile-code-title" title="Code" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail="In the last 30 days"
          icon={GitPullRequest}
          label="Created"
          value={formatCompactNumber(summary.created)}
        />
        <StatCard
          detail="Share of completed changes that merged"
          icon={LibraryBig}
          label="Merge rate"
          value={mergeRate(summary.mergeRate)}
        />
        <StatCard
          detail="Median time from open to merge in the last 30 days"
          icon={Timer}
          label="Median merge time"
          value={medianMergeTime(summary.medianMergeTimeMs)}
        />
        <StatCard
          detail="Conversation cost for changes opened in the last 30 days"
          icon={Coins}
          label="Cost"
          value={costUsd(summary.costUsd)}
        />
      </div>
      <CodeActivityChart
        bucketUnit={timeRangeBucketUnit(props.range)}
        days={selectTimeSeries({
          days: props.report.activityDays,
          hours: props.report.activityHours,
          sixHours: props.report.activitySixHours,
          range: props.range,
          emptySixHour: (date) => ({
            closed: 0,
            created: 0,
            date,
            merged: 0,
          }),
        })}
        range={props.range}
      />
    </section>
  );
}
