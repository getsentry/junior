import type { CodeOverviewReport } from "@sentry/junior/api/schema";
import { Coins, GitPullRequest, LibraryBig, Timer } from "lucide-react";

import { formatDuration } from "../../components/Duration";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatCostSummary } from "../../format";

/** Format a merge rate, or a dash when no change has finished. */
export function formatMergeRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** Format a code cost, or a dash when no cost is recorded. */
export function formatCodeCost(value: number | undefined): string {
  return (
    formatCostSummary(value === undefined ? undefined : { total: value }) || "—"
  );
}

/** Show the 30-day code change summary cards. */
export function CodeSummaryCards(props: {
  summary: CodeOverviewReport["summary"];
}) {
  const summary = props.summary;
  return (
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
        value={formatMergeRate(summary.mergeRate)}
      />
      <StatCard
        detail="Median time from open to merge in the last 30 days"
        icon={Timer}
        label="Median merge time"
        value={formatDuration(summary.medianMergeTimeMs) || "—"}
      />
      <StatCard
        detail="Conversation cost for changes opened in the last 30 days"
        icon={Coins}
        label="Cost"
        value={formatCodeCost(summary.costUsd)}
      />
    </div>
  );
}
