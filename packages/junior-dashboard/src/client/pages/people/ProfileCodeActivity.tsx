import type { CodePersonReport } from "@sentry/junior/api/schema";
import {
  CircleDot,
  GitMerge,
  GitPullRequest,
  LibraryBig,
  Timer,
  XCircle,
} from "lucide-react";
import { formatDuration } from "../../components/Duration";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber } from "../../format";
import { CodeActivityChart } from "../code/CodeActivityChart";

function mergeRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function medianMergeTime(value: number | undefined): string {
  return formatDuration(value) || "—";
}

function hasCodeActivity(report: CodePersonReport): boolean {
  const summary = report.summary;
  return (
    summary.open + summary.created + summary.merged + summary.closed > 0 ||
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          detail="Across all repositories"
          icon={CircleDot}
          label="Open changes"
          value={formatCompactNumber(summary.open)}
        />
        <StatCard
          detail="In the last 30 days"
          icon={GitPullRequest}
          label="Created"
          value={formatCompactNumber(summary.created)}
        />
        <StatCard
          detail="In the last 30 days"
          icon={GitMerge}
          label="Merged"
          value={formatCompactNumber(summary.merged)}
        />
        <StatCard
          detail="Closed without merge in the last 30 days"
          icon={XCircle}
          label="Closed"
          value={formatCompactNumber(summary.closed)}
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
      </div>
      <CodeActivityChart days={props.report.activityDays} range={props.range} />
    </section>
  );
}
