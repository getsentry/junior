import type { ConversationStatsReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { ConversationActivityChart } from "./ConversationActivityChart";
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
    <section aria-label="Runtime telemetry" className="grid gap-4">
      {props.error ? (
        <p className="m-0 font-mono text-xs text-rose-200/65">
          Metrics refresh failed. Showing cached data.
        </p>
      ) : null}
      <ConversationActivityChart days={days} />
      <SystemMetricCharts days={days} />
      <GuardianActivity days={guardianDays} />
    </section>
  );
}
