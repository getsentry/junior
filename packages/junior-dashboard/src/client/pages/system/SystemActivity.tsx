import type { ConversationStatsReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { GuardianActivity } from "./GuardianActivity";

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

  const days = props.stats.metricDays.slice(-props.range);
  const guardianDays = props.stats.guardian.metricDays.slice(-props.range);
  return (
    <section className="grid gap-4" aria-labelledby="system-metrics-title">
      <div>
        <SectionIntro
          eyebrow="Runtime telemetry"
          id="system-metrics-title"
          title="Usage over time"
        />
        {props.error ? (
          <p className="mt-1 mb-0 font-mono text-[0.63rem] text-rose-200/65">
            Metrics refresh failed. Showing cached data.
          </p>
        ) : null}
      </div>
      <SystemMetricCharts days={days} />
      <GuardianActivity days={guardianDays} />
    </section>
  );
}
