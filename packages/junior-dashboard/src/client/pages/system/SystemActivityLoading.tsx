import type { ReactNode } from "react";
import { CircleDollarSign, MessageSquare, Sigma } from "lucide-react";

import { CACHE_INPUT_SERIES } from "../../components/charts/cache-input";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { ChartLegend } from "../../components/charts/ChartLegend";
import {
  timeRangeBucketAdjective,
  timeRangeBucketUnit,
  timeRangeDetail,
  type TimeRangeBucketUnit,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { StatCard } from "../../components/metrics/StatCard";
import { StatTile } from "../../components/metrics/StatTile";
import { Skeleton, SkeletonText } from "../../components/ui/skeleton";

// This file has no chart code, so the route fallback can show it before the
// System page chunk loads. It repeats the static titles and copy of the
// SystemActivity charts, so each box wraps and sizes like the loaded one.

const ROLLING_WINDOW_LABEL: Record<TimeRangeBucketUnit, string> = {
  "6hour": "1-day",
  day: "7-day",
  hour: "6-hour",
};

/**
 * Hold the layout of SystemActivity while conversation stats load: the same
 * grids, cards, headers, and chart heights, so the sections below stay put.
 */
export function SystemActivityLoading(props: { range: TimeRangeDays }) {
  const bucketUnit = timeRangeBucketUnit(props.range);
  const per = bucketUnit === "6hour" ? "6 hours" : bucketUnit;
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">Loading conversation metrics</span>
      <div aria-hidden="true" className="grid gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            detail={`Root conversations in the ${timeRangeDetail(props.range)}`}
            icon={MessageSquare}
            label="Conversations"
            value={<SkeletonText className="w-16" />}
          />
          <StatCard
            detail="All recorded model tokens"
            icon={Sigma}
            label="Tokens"
            value={<SkeletonText className="w-20" />}
          />
          <StatCard
            detail="Estimated model cost"
            icon={CircleDollarSign}
            label="Model spend"
            value={<SkeletonText className="w-24" />}
          />
        </div>
        <ChartCardLoading
          description={
            <>
              <SkeletonText className="w-60" /> Lines are{" "}
              {ROLLING_WINDOW_LABEL[bucketUnit]} rolling means; the legend shows
              the period mean. All spend includes spend that merged nothing.
            </>
          }
          title="Cost per merged change"
          trailing={
            <LegendLoading labels={["Per merged change", "All spend"]} values />
          }
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCardLoading
            description="Daily spend of verified people over the people active that day."
            title="Spend per person"
            trailing={
              <LegendLoading labels={["Mean per person", "Active people"]} />
            }
          />
          <ChartCardLoading
            description="Overhead is spend with no verified person, such as Automation runs."
            title="Spend by Actor"
            trailing={
              <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                <LegendLoading labels={["People", "Overhead"]} values />
                <Skeleton className="-my-1.5 h-7 w-36" />
              </div>
            }
          />
        </div>
        <InputCacheLoading />
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCardLoading title="Model spend" total />
          <ChartCardLoading title="Runtime" total />
        </div>
        <ChartCardLoading
          description={`Root conversations with recorded activity, per ${per}.`}
          title="Conversation activity"
          total
        />
        <GuardianLoading bucketUnit={bucketUnit} />
      </div>
    </div>
  );
}

function ChartCardLoading(props: {
  description?: ReactNode;
  title: string;
  total?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <Card>
      <ChartHeader
        description={props.description}
        title={props.title}
        total={props.total ? <SkeletonText className="w-12" /> : undefined}
        trailing={props.trailing}
      />
      <div className="px-2 py-2">
        <Skeleton className="h-38 w-full" />
      </div>
    </Card>
  );
}

function LegendLoading(props: { labels: string[]; values?: boolean }) {
  return (
    <ChartLegend
      ariaLabel="Loading legend"
      inline
      items={props.labels.map((label) => ({
        color: "var(--color-dashboard-fill-soft)",
        key: label,
        label,
        value: props.values ? <SkeletonText className="w-8" /> : undefined,
      }))}
    />
  );
}

function InputCacheLoading() {
  return (
    <Card>
      <ChartHeader
        title="Input cache"
        trailing={<Skeleton className="h-7 w-32" />}
      />
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3 font-sans text-xs text-dashboard-text-muted sm:px-5">
        {CACHE_INPUT_SERIES.map(({ key, label }) => (
          <div className="flex items-center gap-2" key={key}>
            {label}
            <SkeletonText className="w-8" />
          </div>
        ))}
      </div>
      <div className="px-2 pb-2">
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="border-t border-dashboard-border-subtle px-4 py-3 font-sans text-xs sm:px-5">
        <SkeletonText className="w-28" />
      </div>
    </Card>
  );
}

function GuardianLoading(props: { bucketUnit: TimeRangeBucketUnit }) {
  return (
    <Card>
      <div className="border-b border-dashboard-border-subtle px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle>Guardian reviews</SectionTitle>
            <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
              {timeRangeBucketAdjective(props.bucketUnit)} decisions before
              reviewed actions execute.
            </p>
          </div>
          <div className="font-sans font-medium text-xs text-dashboard-text-muted">
            <span className="mr-3">Allow</span>
            <span className="mr-3">Ask</span>
            <span>Deny</span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {["Requests", "Allowed", "Asked", "Denied", "Estimated cost"].map(
            (label) => (
              <StatTile
                key={label}
                label={label}
                value={<SkeletonText className="w-12" />}
              />
            ),
          )}
        </div>
      </div>
      <div className="px-4 pt-5 pb-3">
        <Skeleton className="h-36 w-full" />
        <div className="mt-2 h-4" />
      </div>
    </Card>
  );
}
