import { useState } from "react";
import type { ConversationStatsReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SystemMetricCharts } from "./SystemMetricCharts";

/** Present selectable daily runtime and model-usage trends. */
export function SystemActivity(props: {
  error: boolean;
  loading: boolean;
  stats: ConversationStatsReport | undefined;
}) {
  const [range, setRange] = useState<TimeRangeDays>(30);

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

  const days = props.stats.metricDays.slice(-range);
  return (
    <section className="grid gap-4" aria-labelledby="system-metrics-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
            Runtime telemetry
          </div>
          <h2
            className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-white"
            id="system-metrics-title"
          >
            Usage over time
          </h2>
          {props.error ? (
            <p className="mt-1 mb-0 font-mono text-[0.63rem] text-rose-200/65">
              Metrics refresh failed. Showing cached data.
            </p>
          ) : null}
        </div>
        <TimeRangeSelector onChange={setRange} value={range} />
      </div>
      <SystemMetricCharts days={days} />
    </section>
  );
}
