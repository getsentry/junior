import { Activity, Bot, Copy, MessageSquare, Timer } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ConversationMetricDay,
  LocationActivityDayReport,
  PeopleActivityDayReport,
} from "@sentry/junior/api/schema";

import { Button, ToggleButton } from "../../components/Button";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { PageHeader } from "../../components/layout/PageHeader";
import { MetricList, MetricValue } from "../../components/Metric";
import { StatCard } from "../../components/metrics/StatCard";
import { TranscriptMarkdown } from "../../conversations/TranscriptMarkdown";
import { TranscriptText } from "../../conversations/TranscriptText";
import { TranscriptToolView } from "../../conversations/TranscriptToolView";
import { cn, dashboardContainerClass } from "../../styles";
import type { TranscriptViewToolCallPart } from "../../types";
import { LocationDirectoryActivityChart } from "../locations/LocationDirectoryActivityChart";
import { ContributionGrid } from "../people/ContributionGrid";
import { PeopleActivityChart } from "../people/PeopleActivityChart";
import { ConversationActivityChart } from "../system/ConversationActivityChart";

const EVENT_NOTIFICATION = `[event notification]

A subscribed resource changed.

Handling:
- This is a subscribed conversation update, not a user-authored command.
- Use the subscription intent to decide whether this event warrants action or a visible reply. Otherwise, stay silent.

Subscription:
- resource: GitHub PR getsentry/junior#999
- event: checks.failed
- intent: watch CI and report regressions

Trusted event summary:
CI failed on workflow test.`;

const GFM_SAMPLE = `## Hard breaks

line one
line two
line three

## Lists and emphasis

- **bold item**
- _italic item_
- inline \`code\` and a [safe link](https://docs.sentry.io)

1. first
2. second

Paragraph after a blank line stays a paragraph.`;

const MIXED_ASSISTANT = `I checked the PR.

Findings:
- the notifier stores real newlines
- the dashboard preserves single breaks as \`<br>\`

See https://docs.sentry.io for product docs.`;

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

type ToolCallFixture = {
  description: string;
  part: TranscriptViewToolCallPart;
  timestamp: number;
};

const TOOL_CALL_TIMESTAMP = Date.UTC(2026, 4, 1, 16);

const TOOL_CALL_FIXTURES = [
  {
    description: "Default completed tool with normalized arguments",
    part: {
      id: "gallery-search",
      input: {
        query: "release regression",
        limit: 25,
        options: { includeArchived: false },
      },
      name: "searchIssues",
      output: { matches: 3 },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 1_842,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP,
  },
  {
    description: "Running webSearch with name-only shimmer",
    part: {
      id: "gallery-running",
      input: {
        query: "service:checkout status:error",
        max_results: 50,
      },
      name: "webSearch",
      status: "running",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 3_000,
  },
  {
    description: "Failed tool with warning rail marker",
    part: {
      id: "gallery-error",
      input: {
        command: "jr-rpc config get github.repo",
        timeout_ms: 10_000,
      },
      name: "bash",
      output: { error: "configuration unavailable" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 6_416,
      status: "error",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 6_000,
  },
  {
    description: "Known loadSkill signature",
    part: {
      id: "gallery-load-skill",
      input: { skill_name: "junior-qa" },
      name: "loadSkill",
      output: { skill_name: "junior-qa" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 8_105,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 8_000,
  },
  {
    description: "Known executeTool signature with nested arguments",
    part: {
      id: "gallery-execute-tool",
      input: {
        tool_name: "github_search",
        arguments: { query: "is:pr is:open", limit: 25 },
      },
      name: "executeTool",
      output: { matches: 3 },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 10_723,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 10_000,
  },
  {
    description: "Long generic arguments exercise both truncation limits",
    part: {
      id: "gallery-long",
      input: {
        project: "payments-checkout-platform",
        query:
          "Find every regression associated with the most recent production deployment and include the complete evidence trail",
        environment: "production",
        includeResolved: false,
        ignoredAfterFourEntries: "not shown in the collapsed preview",
      },
      name: "investigateDeploy",
      output: { channel_id: "C123" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 13_250,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 12_000,
  },
  {
    description: "Completed tool without argument or result payloads",
    part: {
      id: "gallery-empty",
      name: "systemTime",
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 15_000,
  },
] as const satisfies readonly ToolCallFixture[];

/** Config-gated visual fixtures for reusable dashboard components. */
export function ComponentsPage() {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const [pressed, setPressed] = useState(true);

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-8 px-4 py-4 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        description="Reusable dashboard fixtures for visual and interaction checks."
        onRangeChange={setRange}
        range={range}
        title="Component gallery"
      />

      <GallerySection
        description="Shared actions, filters, metrics, and feedback surfaces."
        title="Foundations"
      >
        <Fixture title="Buttons and controls">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              <Copy aria-hidden="true" size={14} />
              Copy
            </Button>
            <Button disabled>Disabled</Button>
            <Button aria-label="Bot action" size="icon">
              <Bot aria-hidden="true" size={16} />
            </Button>
            <ToggleButton
              pressed={pressed}
              variant="pill"
              onClick={() => setPressed((value) => !value)}
            >
              Toggle
            </ToggleButton>
            <ToggleButton
              pressed={!pressed}
              variant="text"
              onClick={() => setPressed((value) => !value)}
            >
              Alternate
            </ToggleButton>
            <TimeRangeSelector onChange={setRange} value={range} />
          </div>
        </Fixture>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            detail="Across the selected period"
            icon={MessageSquare}
            label="Conversations"
            value="1,284"
          />
          <StatCard
            detail="94% completed successfully"
            icon={Activity}
            label="Completed"
            value="1,207"
          />
          <StatCard
            detail="Cumulative agent runtime"
            icon={Timer}
            label="Runtime"
            value="18.4h"
          />
          <StatCard
            detail="Model and tool workers"
            icon={Bot}
            label="Active agents"
            value="7"
          />
        </div>
        <Fixture title="Metadata and empty state">
          <div className="grid gap-4">
            <MetricList
              items={[
                {
                  content: (
                    <MetricValue
                      tooltip={[
                        { label: "input", value: "12.4k" },
                        { label: "output", value: "3.1k" },
                      ]}
                    >
                      15.5k tokens
                    </MetricValue>
                  ),
                  key: "tokens",
                },
                { content: <MetricValue>$0.42</MetricValue>, key: "cost" },
                { content: <MetricValue>38s</MetricValue>, key: "duration" },
              ]}
            />
            <EmptyTelemetry>
              No activity was recorded for this period.
            </EmptyTelemetry>
          </div>
        </Fixture>
      </GallerySection>

      <GallerySection
        description="Production chart components rendered with deterministic fixtures."
        title="Charts"
      >
        <ConversationActivityChart days={METRIC_DAYS} />
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
      </GallerySection>

      <GallerySection
        description="Markdown, event notifications, and transcript role treatments."
        title="Transcripts"
      >
        <Fixture title="Event notification">
          <TranscriptMarkdown compact text={EVENT_NOTIFICATION} />
        </Fixture>
        <Fixture title="GFM sample">
          <TranscriptMarkdown text={GFM_SAMPLE} />
        </Fixture>
        <Fixture title="TranscriptText assistant">
          <TranscriptText role="assistant" text={MIXED_ASSISTANT} />
        </Fixture>
        <Fixture title="TranscriptText user">
          <TranscriptText role="user" text={EVENT_NOTIFICATION} />
        </Fixture>
        <Fixture title="Tool calls">
          <ToolCallGallery />
        </Fixture>
      </GallerySection>
    </div>
  );
}

/** Render typed transcript tool states for visual regression and interaction checks. */
export function ToolCallGallery() {
  return (
    <div className="grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)] gap-3">
      <div aria-hidden="true" className="flex justify-center">
        <span className="w-px bg-cyan-300/15" />
      </div>
      <div className="grid min-w-0 gap-3">
        <p className="m-0 text-xs leading-relaxed text-dashboard-text-muted">
          Click any row to compare its collapsed signature with the full
          arguments and result.
        </p>
        {TOOL_CALL_FIXTURES.map((fixture) => (
          <div className="grid min-w-0 gap-1" key={fixture.part.id}>
            <div className="font-mono text-xs uppercase tracking-[0.08em] text-dashboard-text-muted">
              {fixture.description}
            </div>
            <TranscriptToolView
              part={fixture.part}
              timestamp={fixture.timestamp}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function GallerySection(props: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="grid min-w-0 gap-4">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {props.title}
        </h2>
        <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
          {props.description}
        </p>
      </div>
      {props.children}
    </section>
  );
}

function Fixture(props: { children: ReactNode; title: string }) {
  return (
    <Card className="grid min-w-0 gap-3 p-4 sm:p-5" padding="none">
      <div className="border-b border-white/[0.05] pb-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
        {props.title}
      </div>
      <div className="min-w-0">{props.children}</div>
    </Card>
  );
}

function fixtureDates(count: number): string[] {
  const start = Date.UTC(2026, 4, 1);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}
