import type {
  ConversationMetricDay,
  ConversationStatsReport,
} from "@sentry/junior/api/schema";
import { CircleDollarSign, Gauge, MessageSquare, Sigma } from "lucide-react";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { StatCard } from "../../components/metrics/StatCard";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { formatCompactNumber, formatCostSummary } from "../../format";
import { ConversationActivityChart } from "./ConversationActivityChart";
import { GuardianActivity } from "./GuardianActivity";

function periodTotals(days: ConversationMetricDay[]) {
  return days.reduce(
    (total, day) => ({
      cachedInputTokens: total.cachedInputTokens + (day.cachedInputTokens ?? 0),
      conversations: total.conversations + day.conversations,
      costUsd: total.costUsd + (day.costUsd ?? 0),
      inputTokens: total.inputTokens + (day.inputTokens ?? 0),
      tokens: total.tokens + (day.tokens ?? 0),
    }),
    {
      cachedInputTokens: 0,
      conversations: 0,
      costUsd: 0,
      inputTokens: 0,
      tokens: 0,
    },
  );
}

function formatCacheHitRate(inputTokens: number, cachedInputTokens: number) {
  const totalInputTokens = inputTokens + cachedInputTokens;
  if (!totalInputTokens) return "—";
  return `${((cachedInputTokens / totalInputTokens) * 100).toFixed(1)}%`;
}

/** Present selectable daily runtime and model-usage trends. */
export function SystemActivity(props: {
  error: boolean;
  loading: boolean;
  range: TimeRangeDays;
  stats: ConversationStatsReport | undefined;
}) {
  if (!props.stats) {
    return (
      <Card padding="sm">
        <EmptyTelemetry>
          {props.error
            ? "Conversation metrics failed to load."
            : props.loading
              ? "Loading conversation metrics."
              : "No conversation metrics have been reported yet."}
        </EmptyTelemetry>
      </Card>
    );
  }

  const days = selectTimeSeries({
    days: props.stats.metricDays,
    hours: props.stats.metricHours,
    range: props.range,
  });
  const guardianDays = selectTimeSeries({
    days: props.stats.guardian.metricDays,
    hours: props.stats.guardian.metricHours,
    range: props.range,
  });
  const totals = periodTotals(days);
  const bucketUnit = timeRangeBucketUnit(props.range);
  return (
    <section aria-label="Runtime telemetry" className="grid gap-4">
      {props.error ? (
        <p className="m-0 font-mono text-xs text-rose-200/65">
          Metrics refresh failed. Showing cached data.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail={`Root conversations in the ${timeRangeDetail(props.range)}`}
          icon={MessageSquare}
          label="Conversations"
          value={formatCompactNumber(totals.conversations)}
        />
        <StatCard
          detail="All recorded model tokens"
          icon={Sigma}
          label="Tokens"
          value={formatCompactNumber(totals.tokens)}
        />
        <StatCard
          detail="Estimated model cost"
          icon={CircleDollarSign}
          label="Model spend"
          value={formatCostSummary({ total: totals.costUsd })}
        />
        <StatCard
          detail={`${formatCompactNumber(totals.cachedInputTokens)} cached · ${formatCompactNumber(totals.inputTokens)} uncached`}
          icon={Gauge}
          label="Cache hit rate"
          value={formatCacheHitRate(
            totals.inputTokens,
            totals.cachedInputTokens,
          )}
        />
      </div>
      <ConversationActivityChart bucketUnit={bucketUnit} days={days} />
      <SystemMetricCharts
        bucketUnit={bucketUnit}
        cacheBreakdown
        days={days}
      />
      <GuardianActivity bucketUnit={bucketUnit} days={guardianDays} />
    </section>
  );
}
