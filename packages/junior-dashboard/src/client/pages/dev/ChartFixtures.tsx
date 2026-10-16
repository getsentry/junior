import type { ReactNode } from "react";
import type {
  AutomationExecutionDay,
  AutomationExecutionStatusDay,
  CodeActivityDay,
  ConversationMetricDay,
  DailyConversationActivity,
  GuardianMetricDay,
  LocationActivityDayReport,
  PeopleActivityDayReport,
  PluginOperationalReport,
} from "@sentry/junior/api/schema";
import { InputCacheChart } from "../../components/charts/InputCacheChart";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { WorkspaceUsageChart } from "../../components/charts/WorkspaceUsageChart";
import { AutomationCostChart } from "../automations/AutomationCostChart";
import { AutomationExecutionChart } from "../automations/AutomationExecutionChart";
import { AutomationExecutionStatusChart } from "../automations/AutomationExecutionStatusChart";
import { CodeActivityChart } from "../code/CodeActivityChart";
import { LocationActivityChart } from "../locations/LocationActivityChart";
import { LocationDirectoryActivityChart } from "../locations/LocationDirectoryActivityChart";
import { MemoryCostChart } from "../memory/MemoryCostChart";
import { MemoryTimeline } from "../memory/MemoryTimeline";
import type { MemoryCostDay, MemoryDay } from "../memory/memoryDashboard";
import { ContributionGrid } from "../people/ContributionGrid";
import { PeopleActivityChart } from "../people/PeopleActivityChart";
import { ConversationActivityChart } from "../system/ConversationActivityChart";
import { GuardianActivity } from "../system/GuardianActivity";
import { PluginBarChart } from "../system/PluginBarChart";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";

type PluginWidget = NonNullable<PluginOperationalReport["widgets"]>[number];

// The gallery browser scenario saves one image for each id.
const CHART_FIXTURE_IDS = [
  "conversation-activity",
  "conversation-activity-hourly",
  "input-cache",
  "system-metrics",
  "people-activity",
  "location-directory-activity",
  "location-activity",
  "code-activity",
  "code-activity-dense",
  "code-activity-empty",
  "workspace-usage",
  "automation-executions",
  "automation-execution-status",
  "automation-cost",
  "memory-timeline",
  "memory-cost",
  "guardian-activity",
  "plugin-bar-chart",
  "contribution-grid",
] as const;

type ChartFixtureId = (typeof CHART_FIXTURE_IDS)[number];

const METRIC_DAYS: ConversationMetricDay[] = fixtureDates(14).map(
  (date, index) => ({
    conversations: 4 + ((index * 5) % 17),
    costUsd: 0.7 + ((index * 7) % 11) * 0.18,
    date,
    durationMs: 90_000 + ((index * 41) % 13) * 24_000,
    tokens: 18_000 + ((index * 17) % 19) * 2_300,
  }),
);

const HOURLY_METRIC_DAYS: ConversationMetricDay[] = fixtureHours(24).map(
  (date, index) => ({
    conversations: index % 5 === 0 ? 0 : 1 + ((index * 7) % 9),
    costUsd: 0.05 + ((index * 3) % 7) * 0.04,
    date,
    durationMs: 30_000 + ((index * 11) % 7) * 9_000,
    tokens: 2_000 + ((index * 13) % 11) * 400,
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

const LOCATION_DETAIL_DAYS: DailyConversationActivity[] = fixtureDates(90).map(
  (date, index) => {
    const conversations = index % 11 === 0 ? 0 : 2 + ((index * 7) % 15);
    return {
      active: Math.min(conversations, index % 4),
      conversations,
      date,
      durationMs: conversations * 60_000,
      failed: index % 13 === 0 ? 1 : 0,
    };
  },
);

const CODE_DAYS: CodeActivityDay[] = codeDays(30);

const DENSE_CODE_DAYS: CodeActivityDay[] = codeDays(90);

const EMPTY_CODE_DAYS: CodeActivityDay[] = fixtureDates(30).map((date) => ({
  closed: 0,
  created: 0,
  date,
  merged: 0,
}));

const WORKSPACE_USAGE_DAYS = fixtureDates(30).map((date, index) => ({
  count: index % 6 === 0 ? 0 : 1 + ((index * 5) % 9),
  date,
}));

const AUTOMATION_DAYS: AutomationExecutionDay[] = fixtureDates(30).map(
  (date, index) => ({
    costUsd: index % 7 === 0 ? 0 : 0.04 + ((index * 5) % 9) * 0.11,
    date,
    event: (index * 3) % 5,
    scheduled: index % 7 === 0 ? 0 : 1 + ((index * 7) % 6),
  }),
);

const AUTOMATION_STATUS_DAYS: AutomationExecutionStatusDay[] = fixtureDates(
  30,
).map((date, index) => ({
  blocked: index % 9 === 0 ? 1 : 0,
  completed: index % 7 === 0 ? 0 : 1 + ((index * 5) % 4),
  date,
  failed: index % 5 === 0 ? 1 : 0,
}));

const MEMORY_DAYS: MemoryDay[] = fixtureDates(30).map((date, index) => ({
  date,
  personal: index % 8 === 0 ? 0 : (index * 3) % 7,
  public: (index * 5) % 4,
}));

const MEMORY_EXTRACTION_DAYS: MemoryCostDay[] = fixtureDates(30).map(
  (date, index) => ({
    costUsd: index % 8 === 0 ? 0 : 0.02 + ((index * 7) % 9) * 0.015,
    date,
    events: index % 8 === 0 ? 0 : 1 + ((index * 3) % 6),
  }),
);

const MEMORY_RECALL_DAYS: MemoryCostDay[] = fixtureDates(30).map(
  (date, index) => ({
    costUsd: 0.01 + ((index * 5) % 7) * 0.008,
    date,
    events: 2 + ((index * 5) % 9),
  }),
);

const GUARDIAN_DAYS: GuardianMetricDay[] = fixtureDates(30).map(
  (date, index) => {
    const allow = 6 + ((index * 7) % 19);
    const ask = (index * 3) % 5;
    const deny = index % 6 === 0 ? 2 : 0;
    return {
      allow,
      ask,
      costUsd: (allow + ask + deny) * 0.0021,
      date,
      deny,
      requests: allow + ask + deny,
    };
  },
);

const PLUGIN_WIDGET: PluginWidget = {
  categories: fixtureDates(14).map((date, index) => ({
    id: date,
    label: date,
    values: {
      failed: index % 4 === 0 ? 2 : 0,
      succeeded: 3 + ((index * 5) % 11),
    },
  })),
  description: "Deliveries reported by the plugin.",
  id: "deliveries",
  series: [
    { key: "succeeded", label: "Succeeded", tone: "good" },
    { key: "failed", label: "Failed", tone: "danger" },
  ],
  title: "Deliveries",
  type: "bar_chart",
};

const CONTRIBUTION_DAYS = fixtureDates(70).map((date, index) => ({
  conversations: index % 9 === 0 ? 0 : 1 + ((index * 7) % 18),
  date,
  durationMs: index % 9 === 0 ? 0 : 45_000 + ((index * 13) % 20) * 18_000,
}));

/** Render every dashboard chart with fixed data for visual review. */
export function ChartFixtures() {
  return (
    <>
      <ChartFixture id="conversation-activity">
        <ConversationActivityChart days={METRIC_DAYS} />
      </ChartFixture>
      <ChartFixture id="conversation-activity-hourly">
        <ConversationActivityChart
          bucketUnit="hour"
          days={HOURLY_METRIC_DAYS}
        />
      </ChartFixture>
      <ChartFixture id="input-cache">
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
      </ChartFixture>
      <ChartFixture id="system-metrics">
        <SystemMetricCharts days={METRIC_DAYS} />
      </ChartFixture>
      <ChartFixture id="people-activity">
        <PeopleActivityChart days={PEOPLE_DAYS} />
      </ChartFixture>
      <ChartFixture id="location-directory-activity">
        <LocationDirectoryActivityChart days={LOCATION_DAYS} />
      </ChartFixture>
      <ChartFixture id="location-activity">
        <LocationActivityChart days={LOCATION_DETAIL_DAYS} />
      </ChartFixture>
      <ChartFixture id="code-activity">
        <CodeActivityChart days={CODE_DAYS} range={30} />
      </ChartFixture>
      <ChartFixture id="code-activity-dense">
        <CodeActivityChart days={DENSE_CODE_DAYS} range={90} />
      </ChartFixture>
      <ChartFixture id="code-activity-empty">
        <CodeActivityChart days={EMPTY_CODE_DAYS} range={30} />
      </ChartFixture>
      <ChartFixture id="workspace-usage">
        <WorkspaceUsageChart
          days={WORKSPACE_USAGE_DAYS}
          range={30}
          workspaceName="junior"
        />
      </ChartFixture>
      <ChartFixture id="automation-executions">
        <AutomationExecutionChart days={AUTOMATION_DAYS} range={30} />
      </ChartFixture>
      <ChartFixture id="automation-execution-status">
        <AutomationExecutionStatusChart
          days={AUTOMATION_STATUS_DAYS}
          range={30}
        />
      </ChartFixture>
      <ChartFixture id="automation-cost">
        <AutomationCostChart days={AUTOMATION_DAYS} range={30} />
      </ChartFixture>
      <ChartFixture id="memory-timeline">
        <MemoryTimeline days={MEMORY_DAYS} range={30} />
      </ChartFixture>
      <ChartFixture id="memory-cost">
        <MemoryCostChart
          extractionDays={MEMORY_EXTRACTION_DAYS}
          range={30}
          recallDays={MEMORY_RECALL_DAYS}
        />
      </ChartFixture>
      <ChartFixture id="guardian-activity">
        <GuardianActivity days={GUARDIAN_DAYS} />
      </ChartFixture>
      <ChartFixture id="plugin-bar-chart">
        <PluginBarChart widget={PLUGIN_WIDGET} />
      </ChartFixture>
      <ChartFixture id="contribution-grid">
        <Card>
          <CardHeader
            description="Daily conversation intensity over ten weeks."
            title="Contribution activity"
          />
          <ContributionGrid days={CONTRIBUTION_DAYS} />
        </Card>
      </ChartFixture>
    </>
  );
}

function ChartFixture(props: { children: ReactNode; id: ChartFixtureId }) {
  return <div data-gallery-chart={props.id}>{props.children}</div>;
}

function codeDays(count: number): CodeActivityDay[] {
  return fixtureDates(count).map((date, index) => ({
    closed: index % 9 === 0 ? 1 : 0,
    created: index % 4 === 0 ? 0 : 1 + ((index * 5) % 3),
    date,
    merged: index % 3 === 0 ? 1 + (index % 2) : 0,
  }));
}

function fixtureDates(count: number): string[] {
  const start = Date.UTC(2026, 4, 1);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function fixtureHours(count: number): string[] {
  const start = Date.UTC(2026, 4, 1);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 3_600_000).toISOString().slice(0, 13),
  );
}
