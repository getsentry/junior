import { Activity, Bot, Copy, MessageSquare, Timer } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ConversationMetricDay,
  LocationActivityDayReport,
  PeopleActivityDayReport,
} from "@sentry/junior/api/schema";

import { Button, ToggleButton } from "../../components/Button";
import { LocationDirectoryActivityChart } from "../../components/charts/LocationDirectoryActivityChart";
import { PeopleActivityChart } from "../../components/charts/PeopleActivityChart";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import { ContributionGrid } from "../../components/ContributionGrid";
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
import { TranscriptMarkdown } from "../../components/TranscriptMarkdown";
import { TranscriptText } from "../../components/TranscriptText";
import { cn, dashboardContainerClass } from "../../styles";

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
        eyebrow="Development"
        title="Component gallery"
      />

      <GallerySection
        description="Shared actions, filters, metrics, and feedback surfaces."
        title="Foundations"
      >
        <Fixture title="Buttons and controls">
          <div className="flex flex-wrap items-center gap-3">
            <Button><Copy aria-hidden="true" size={14} />Copy</Button>
            <Button disabled>Disabled</Button>
            <Button aria-label="Bot action" size="icon"><Bot aria-hidden="true" size={16} /></Button>
            <ToggleButton pressed={pressed} variant="pill" onClick={() => setPressed((value) => !value)}>Toggle</ToggleButton>
            <ToggleButton pressed={!pressed} variant="text" onClick={() => setPressed((value) => !value)}>Alternate</ToggleButton>
            <TimeRangeSelector onChange={setRange} value={range} />
          </div>
        </Fixture>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard detail="Across the selected period" icon={MessageSquare} label="Conversations" value="1,284" />
          <StatCard detail="94% completed successfully" icon={Activity} label="Completed" value="1,207" />
          <StatCard detail="Cumulative agent runtime" icon={Timer} label="Runtime" value="18.4h" />
          <StatCard detail="Model and tool workers" icon={Bot} label="Active agents" value="7" />
        </div>
        <Fixture title="Metadata and empty state">
          <div className="grid gap-4">
            <MetricList
              items={[
                { content: <MetricValue tooltip={[{ label: "input", value: "12.4k" }, { label: "output", value: "3.1k" }]}>15.5k tokens</MetricValue>, key: "tokens" },
                { content: <MetricValue>$0.42</MetricValue>, key: "cost" },
                { content: <MetricValue>38s</MetricValue>, key: "duration" },
              ]}
            />
            <EmptyTelemetry>No activity was recorded for this period.</EmptyTelemetry>
          </div>
        </Fixture>
      </GallerySection>

      <GallerySection
        description="Production chart components rendered with deterministic fixtures."
        title="Charts"
      >
        <SystemMetricCharts days={METRIC_DAYS} />
        <PeopleActivityChart days={PEOPLE_DAYS} />
        <LocationDirectoryActivityChart days={LOCATION_DAYS} />
        <Card>
          <CardHeader description="Daily conversation intensity over ten weeks." title="Contribution activity" />
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
          <TranscriptText firstChildIndex={0} lastChildIndex={0} role="assistant" text={MIXED_ASSISTANT} />
        </Fixture>
        <Fixture title="TranscriptText user">
          <TranscriptText firstChildIndex={0} lastChildIndex={0} role="user" text={EVENT_NOTIFICATION} />
        </Fixture>
      </GallerySection>
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
        <h2 className="m-0 font-display text-xl font-medium text-white">{props.title}</h2>
        <p className="mt-1 mb-0 text-sm text-white/45">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

function Fixture(props: { children: ReactNode; title: string }) {
  return (
    <Card className="grid min-w-0 gap-3 p-4 sm:p-5" padding="none">
      <div className="border-b border-white/[0.05] pb-3 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/45">
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
