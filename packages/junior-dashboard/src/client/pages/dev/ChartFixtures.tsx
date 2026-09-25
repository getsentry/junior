import type {
  ConversationMetricDay,
  LocationActivityDayReport,
  PeopleActivityDayReport,
} from "@sentry/junior/api/schema";
import { InputCacheChart } from "../../components/charts/InputCacheChart";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { LocationDirectoryActivityChart } from "../locations/LocationDirectoryActivityChart";
import { ContributionGrid } from "../people/ContributionGrid";
import { PeopleActivityChart } from "../people/PeopleActivityChart";
import { ConversationActivityChart } from "../system/ConversationActivityChart";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";

const METRIC_DAYS: ConversationMetricDay[] = fixtureDates(14).map(
  (date, index) => ({
    conversations: 4 + ((index * 5) % 17),
    costUsd: 0.7 + ((index * 7) % 11) * 0.18,
    date,
    durationMs: 90_000 + ((index * 41) % 13) * 24_000,
    tokens: 18_000 + ((index * 17) % 19) * 2_300,
  }),
);

const PEOPLE_DAYS: PeopleActivityDayReport[] = fixtureDates(30).map(
  (date, index) => ({
    activePeople: 4 + ((index * 7) % 13),
    conversations: 18 + ((index * 11) % 31),
    date,
  }),
);

const LOCATION_DAYS: LocationActivityDayReport[] = fixtureDates(30).map(
  (date, index) => ({
    date,
    privateConversations: 3 + ((index * 5) % 12),
    publicConversations: 12 + ((index * 9) % 28),
  }),
);

const CONTRIBUTION_DAYS = fixtureDates(70).map((date, index) => ({
  conversations: index % 9 === 0 ? 0 : 1 + ((index * 7) % 18),
  date,
  durationMs: index % 9 === 0 ? 0 : 45_000 + ((index * 13) % 20) * 18_000,
}));

/** Render chart examples with cache drops and missing counters for visual review. */
export function ChartFixtures() {
  return (
    <>
      <ConversationActivityChart days={METRIC_DAYS} />
      <InputCacheChart
        bucketUnit="day"
        days={METRIC_DAYS.map((day, index) => ({
          ...day,
          inputTokens: 2_000,
          cachedInputTokens: index === 9 ? 8_000 : 180_000,
          cacheCreationTokens:
            index === 5 ? undefined : index === 9 ? 190_000 : 10_000,
        }))}
      />
      <SystemMetricCharts days={METRIC_DAYS} />
      <PeopleActivityChart days={PEOPLE_DAYS} />
      <LocationDirectoryActivityChart days={LOCATION_DAYS} />
      <Card>
        <CardHeader
          description="Daily conversation intensity over ten weeks."
          title="Contribution activity"
        />
        <ContributionGrid days={CONTRIBUTION_DAYS} />
      </Card>
    </>
  );
}

function fixtureDates(count: number): string[] {
  const start = Date.UTC(2026, 4, 1);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}
