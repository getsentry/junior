import { ChartFixtures } from "./ChartFixtures";
import { ObjectCard } from "../../conversations/ObjectCard";
import { AutomationCard } from "../../components/AutomationCard";
import {
  Activity,
  Bot,
  ChevronRight,
  Copy,
  MessageSquare,
  Timer,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, Route, Routes } from "react-router";

import { Button, ToggleButton } from "../../components/Button";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Drawer } from "../../components/Drawer";
import { Field } from "../../components/Field";
import { Card } from "../../components/layout/Card";
import { DashboardChromeProvider } from "../../components/layout/DashboardChrome";
import { DashboardHeader } from "../../components/layout/DashboardHeader";
import { PageHeader } from "../../components/layout/PageHeader";
import { MetricList, MetricValue } from "../../components/Metric";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { ParticipantAvatarStack } from "../../components/ParticipantAvatarStack";
import { StatCard } from "../../components/metrics/StatCard";
import { StatusChip } from "../../components/StatusChip";
import { StatusDot } from "../../components/StatusDot";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { TextArea, TextInput } from "../../components/TextInput";
import { TranscriptMarkdown } from "../../conversations/TranscriptMarkdown";
import { TranscriptText } from "../../conversations/TranscriptText";
import { TranscriptMessageShell } from "../../conversations/TranscriptMessageShell";
import { TranscriptToolView } from "../../conversations/TranscriptToolView";
import { cn, dashboardContainerClass } from "../../styles";
import type { TranscriptViewToolCallPart } from "../../types";

export type GallerySectionId = "foundations" | "charts" | "transcripts";

export type GallerySectionMeta = {
  description: string;
  id: GallerySectionId;
  title: string;
};

/** Catalog of gallery sections used by the index and visual scenarios. */
export const GALLERY_SECTIONS: readonly GallerySectionMeta[] = [
  {
    description: "Buttons, forms, status chips, metrics, and empty states.",
    id: "foundations",
    title: "Foundations",
  },
  {
    description: "Production chart components with deterministic fixtures.",
    id: "charts",
    title: "Charts",
  },
  {
    description: "Markdown, event notifications, and transcript tool states.",
    id: "transcripts",
    title: "Transcripts",
  },
] as const;

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

## Table

| Service | Status | p95 |
| --- | :---: | ---: |
| **relay** | healthy | 42ms |
| snuba | degraded | 180ms |
| \`ingest\` | healthy | 31ms |

## Wide table

| Service | Region | Owner | Deploy | Status | p50 | p95 | p99 | Errors | Notes |
| --- | --- | --- | --- | :---: | ---: | ---: | ---: | ---: | --- |
| **relay** | us-central1 | platform | payments-v42 | healthy | 18ms | 42ms | 91ms | 0.1% | baseline |
| snuba | us-central1 | data | snuba-nightly | degraded | 64ms | 180ms | 420ms | 0.8% | queue pressure |
| \`ingest\` | europe-west3 | pipeline | ingest-2026.08 | healthy | 12ms | 31ms | 77ms | 0.2% | within budget |
| checkout | us-west1 | payments | payments-v42 | degraded | 210ms | **890ms** | 1.4s | 0.5% | post-deploy spike |

Paragraph after a blank line stays a paragraph.`;

const MIXED_ASSISTANT = `I checked the PR.

Findings:
- the notifier stores real newlines
- the dashboard preserves single breaks as \`<br>\`

See https://docs.sentry.io for product docs.`;

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
    description: "Failed tool",
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

/** Config-gated component gallery with one page per category. */
export function ComponentsPage() {
  return (
    <Routes>
      <Route element={<GalleryIndexPage />} index />
      <Route element={<FoundationsGalleryPage />} path="foundations" />
      <Route element={<ChartsGalleryPage />} path="charts" />
      <Route element={<TranscriptsGalleryPage />} path="transcripts" />
      <Route element={<Navigate replace to="/dev" />} path="*" />
    </Routes>
  );
}

function GalleryIndexPage() {
  return (
    <GalleryShell
      description="Reusable dashboard fixtures. Open one section for manual checks or focused visual review."
      title="Component gallery"
    >
      <div className="grid gap-3">
        {GALLERY_SECTIONS.map((section) => (
          <Link
            className="group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-dashboard-border bg-dashboard-fill-faint px-4 py-4 no-underline transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-fill-soft"
            key={section.id}
            to={`/dev/${section.id}`}
          >
            <div className="min-w-0">
              <div className="font-display text-lg font-medium text-dashboard-text">
                {section.title}
              </div>
              <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
                {section.description}
              </p>
            </div>
            <ChevronRight
              aria-hidden="true"
              className="shrink-0 text-dashboard-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-dashboard-text"
              size={18}
            />
          </Link>
        ))}
      </div>
    </GalleryShell>
  );
}

function FoundationsGalleryPage() {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const [pressed, setPressed] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nestedDrawerOpen, setNestedDrawerOpen] = useState(false);
  const [tab, setTab] = useState<"details" | "memories" | "usage">("details");

  return (
    <GalleryShell
      description="Shared actions, forms, status chips, metrics, and empty states."
      sectionId="foundations"
      title="Foundations"
    >
      <Fixture title="Conversation navigation">
        <DashboardChromeProvider>
          <DashboardHeader
            compact
            mobileNavigationOpen={navigationOpen}
            navItems={[
              { key: "code", label: "Code", to: "/code" },
              { key: "system", label: "System", to: "/system" },
            ]}
            onMobileNavigationOpenChange={setNavigationOpen}
            workspaceActive
          />
        </DashboardChromeProvider>
      </Fixture>
      <Fixture title="Segmented tabs">
        <div className="max-w-md">
          <SegmentedTabs
            items={[
              { label: "Details", value: "details" },
              { label: "Memories", value: "memories" },
              { label: "Usage", value: "usage" },
            ]}
            label="Conversation panels"
            onChange={setTab}
            value={tab}
          >
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              {tab === "details"
                ? "Conversation summary and linked work."
                : tab === "memories"
                  ? "What Junior learned from this conversation."
                  : "Time, tokens, and cost for this conversation."}
            </p>
          </SegmentedTabs>
        </div>
      </Fixture>
      <Fixture title="Narrow details drawer">
        <Button onClick={() => setDrawerOpen(true)}>Open details</Button>
        {drawerOpen ? (
          <Drawer
            closeLabel="Close gallery details"
            dismissLabel="Dismiss gallery details"
            header={
              <h2
                id="gallery-drawer-title"
                className="m-0 text-lg font-semibold"
              >
                Conversation details
              </h2>
            }
            onClose={() => setDrawerOpen(false)}
            openKey="gallery-details"
            titleId="gallery-drawer-title"
            width="narrow"
          >
            <p className="m-0 text-sm leading-relaxed text-dashboard-text-muted">
              Linked work, the Brief, participants, and usage.
            </p>
            <Button onClick={() => setNestedDrawerOpen(true)}>
              Open nested details
            </Button>
            {nestedDrawerOpen
              ? createPortal(
                  <Drawer
                    closeLabel="Close nested details"
                    dismissLabel="Dismiss nested details"
                    header={
                      <h2
                        id="gallery-nested-title"
                        className="m-0 text-lg font-semibold"
                      >
                        Event details
                      </h2>
                    }
                    onClose={() => setNestedDrawerOpen(false)}
                    openKey="gallery-nested"
                    titleId="gallery-nested-title"
                  >
                    <p className="m-0 text-sm text-dashboard-text-muted">
                      Escape closes this drawer and returns focus to the parent
                      drawer.
                    </p>
                  </Drawer>,
                  document.body,
                )
              : null}
          </Drawer>
        ) : null}
      </Fixture>
      <Fixture title="Color tokens">
        <div className="grid gap-4">
          <TokenSwatchRow
            label="Canvas / surface"
            swatches={[
              { className: "bg-dashboard-bg", label: "bg" },
              { className: "bg-dashboard-bg-elevated", label: "elevated" },
              { className: "bg-dashboard-surface-panel", label: "panel" },
              { className: "bg-dashboard-surface-active", label: "active" },
              { className: "bg-dashboard-surface-raised", label: "raised" },
              { className: "bg-dashboard-surface-hover", label: "hover" },
              { className: "bg-dashboard-control", label: "control" },
              { className: "bg-dashboard-ink", label: "ink" },
            ]}
          />
          <TokenSwatchRow
            label="Text"
            swatches={[
              { className: "bg-dashboard-text", label: "text" },
              { className: "bg-dashboard-text-muted", label: "muted" },
              { className: "bg-dashboard-text-subtle", label: "subtle" },
              { className: "bg-dashboard-text-faint", label: "faint" },
              { className: "bg-dashboard-focus", label: "focus" },
            ]}
          />
          <TokenSwatchRow
            label="Border"
            swatches={[
              {
                className:
                  "bg-transparent border-2 border-dashboard-border-subtle",
                label: "subtle",
              },
              {
                className: "bg-transparent border-2 border-dashboard-border",
                label: "border",
              },
              {
                className:
                  "bg-transparent border-2 border-dashboard-border-strong",
                label: "strong",
              },
              {
                className:
                  "bg-transparent border-2 border-dashboard-border-emphasis",
                label: "emphasis",
              },
              {
                className:
                  "bg-transparent border-2 border-dashboard-border-interactive",
                label: "interactive",
              },
            ]}
          />
          <TokenSwatchRow
            label="Fill / overlay"
            swatches={[
              { className: "bg-dashboard-fill-faint", label: "faint" },
              { className: "bg-dashboard-fill-soft", label: "soft" },
              { className: "bg-dashboard-fill-hover", label: "hover" },
              { className: "bg-dashboard-fill-strong", label: "strong" },
              { className: "bg-dashboard-overlay-soft", label: "overlay soft" },
              { className: "bg-dashboard-overlay", label: "overlay" },
            ]}
          />
        </div>
      </Fixture>
      <Fixture title="Buttons and controls">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              <Copy aria-hidden="true" size={14} />
              Copy
            </Button>
            <Button disabled>Disabled</Button>
            <Button tone="danger">
              <Trash2 aria-hidden="true" size={14} />
              Remove
            </Button>
            <Button disabled tone="danger">
              Remove disabled
            </Button>
            <Button aria-label="Bot action" size="icon">
              <Bot aria-hidden="true" size={16} />
            </Button>
            <Button aria-label="Delete action" size="icon" tone="danger">
              <Trash2 aria-hidden="true" size={16} />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
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
            <ToggleButton pressed variant="segment">
              30d
            </ToggleButton>
            <ToggleButton pressed={false} variant="segment">
              90d
            </ToggleButton>
            <TimeRangeSelector onChange={setRange} value={range} />
          </div>
        </div>
      </Fixture>
      <Fixture title="Forms">
        <div className="grid max-w-xl gap-4">
          <Card className="mb-0" padding="md" variant="raised">
            <Field
              help="Lowercase name used when agents switch into this Workspace."
              htmlFor="gallery-workspace-name"
              label="Name"
            >
              <TextInput
                defaultValue="sentry"
                id="gallery-workspace-name"
                placeholder="sentry"
              />
            </Field>
          </Card>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)]">
            <Field htmlFor="gallery-provider" label="Provider" size="compact">
              <TextInput
                defaultValue="github"
                id="gallery-provider"
                placeholder="github"
              />
            </Field>
            <Field
              htmlFor="gallery-repository"
              label="Repository"
              size="compact"
            >
              <TextInput
                defaultValue="getsentry/sentry"
                id="gallery-repository"
                placeholder="getsentry/sentry"
              />
            </Field>
          </div>
          <Field
            help="Runs once while Junior builds the reusable snapshot."
            htmlFor="gallery-setup-script"
            label="Setup script"
          >
            <TextArea
              defaultValue={'pnpm install --dir "$JUNIOR_REPOS_ROOT/sentry"'}
              id="gallery-setup-script"
            />
          </Field>
          <TextInput
            aria-label="Disabled text input"
            disabled
            value="read only"
          />
        </div>
      </Fixture>
      <Fixture title="Status chips">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="neutral">private</StatusChip>
          <StatusChip tone="success">completed</StatusChip>
          <StatusChip tone="danger">failed</StatusChip>
          <StatusChip tone="warning">blocked</StatusChip>
          <StatusChip tone="info">preference</StatusChip>
          <StatusChip tone="accent">knowledge</StatusChip>
          <StatusChip size="compact" tone="success">
            public
          </StatusChip>
        </div>
      </Fixture>
      <Fixture title="Participant avatars">
        <div className="flex flex-wrap items-center gap-8">
          <ParticipantAvatarStack
            participants={[
              { email: "ada@example.com", fullName: "Ada Lovelace" },
              { email: "grace@example.com", fullName: "Grace Hopper" },
              { email: "alan@example.com", fullName: "Alan Turing" },
              { email: "katherine@example.com", fullName: "Katherine Johnson" },
            ]}
            size="list"
          />
          <ParticipantAvatarStack
            participants={[
              { email: "ada@example.com", fullName: "Ada Lovelace" },
              { email: "grace@example.com", fullName: "Grace Hopper" },
              { email: "alan@example.com", fullName: "Alan Turing" },
              { email: "katherine@example.com", fullName: "Katherine Johnson" },
            ]}
            size="detail"
          />
        </div>
      </Fixture>
      <Fixture title="Status dots">
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot label="completed" tone="success" />
          <StatusDot label="failed" tone="danger" />
          <StatusDot label="blocked" tone="warning" />
          <StatusDot label="idle" tone="neutral" />
          <StatusDot label="info" tone="info" />
          <StatusDot label="accent" tone="accent" />
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
      <Fixture title="Page loading">
        <PageContentSkeleton label="Loading example" variant="stats" />
      </Fixture>
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
    </GalleryShell>
  );
}

function ChartsGalleryPage() {
  return (
    <GalleryShell
      description="Production chart components rendered with deterministic fixtures."
      sectionId="charts"
      title="Charts"
    >
      <ChartFixtures />
    </GalleryShell>
  );
}

function TranscriptsGalleryPage() {
  return (
    <GalleryShell
      description="Markdown, event notifications, and transcript role treatments."
      sectionId="transcripts"
      title="Transcripts"
    >
      <Fixture title="Object annotations">
        <ObjectCard
          card={{
            kind: "object",
            objectType: "code_change",
            plugin: "github",
            key: "getsentry/junior#1200",
            label: "getsentry/junior#1200",
            title: "Use object annotations for reply cards",
            status: "open",
            displayType: "Pull request",
            sourceUpdatedAt: "2026-09-25T13:45:00Z",
            facts: {
              type: "code_change",
              author: "alex",
              review: "changes_requested",
              checks: { passed: 12, failed: 1, pending: 0 },
              reviewers: ["sam"],
              mergeable: false,
              sourceBranch: "feature/object-cards",
              targetBranch: "main",
              changedFiles: 8,
              additions: 120,
              deletions: 30,
            },
            url: "https://github.com/getsentry/junior/pull/1200",
          }}
        />
        <ObjectCard
          card={{
            kind: "object",
            objectType: "task",
            plugin: "linear",
            key: "ENG-123",
            label: "ENG-123",
            title: "Keep background annotation updates out of the next reply",
            status: "In Progress",
            facts: {
              type: "task",
              assignees: ["Sam"],
              priority: "High",
              project: "Conversation quality",
              cycle: "September",
              dueDate: "2026-09-30",
              labels: ["UX", "Reliability"],
            },
            url: "https://linear.app/example/issue/ENG-123",
          }}
        />
        <ObjectCard
          card={{
            kind: "object",
            objectType: "item",
            displayType: "Deployment",
            plugin: "vercel",
            key: "dpl_example",
            label: "dpl_example",
            title: "junior-docs.vercel.app",
            status: "READY",
            url: "https://junior-docs.vercel.app",
            facts: {
              type: "deployment",
              environment: "production",
              project: "junior-docs",
              revision: "ca37e26a9",
              branch: "main",
            },
          }}
        />
        <ObjectCard
          card={{
            kind: "object",
            objectType: "item",
            plugin: "example",
            key: "note",
            label: "note",
            title: "A saved item without a source link",
            url: null,
          }}
        />
      </Fixture>
      <Fixture title="Automation in a reply">
        <div className="max-w-[52.5rem]">
          <TranscriptMessageShell actor="Junior" role="assistant">
            <span className="text-sm font-semibold text-cyan-100">Junior</span>
            <TranscriptText
              role="assistant"
              text={
                "Your reminder is set.\n\nI'll remind you to drink water every 30 minutes until you ask me to stop."
              }
            />
            <AutomationCard
              card={{
                id: "sched_0123456789abcdef0123456789abcdef",
                title: "Drink water",
                instruction:
                  "Remind the user to drink water with a short friendly message in this conversation. Then create another one-off reminder after 30 minutes.",
                trigger: "In 30 minutes",
                warning: null,
              }}
            />
          </TranscriptMessageShell>
        </div>
      </Fixture>
      <Fixture title="Automation card states">
        <AutomationCard
          card={{
            id: "sched_0123456789abcdef0123456789abcdef",
            title: "Drink water reminder",
            status: "active",
            instruction: "Remind the user to drink water in this conversation.",
            trigger: "Sep 23, 2026, 9:30 AM · America/Los_Angeles",
            warning: null,
          }}
        />
        <AutomationCard
          card={{
            id: "evt_0ffb0d2027d4b7600b64287bd6dc2b14",
            title:
              "Review automated fixes across the JavaScript SDK repositories",
            instruction:
              "Review Sentry PRs. Close invalid fixes and correct valid ones. Post in #proj-junior only when ready for human merge.",
            trigger:
              'getsentry/junior · pull_request.opened · author = "sentry[bot]"',
            warning: null,
          }}
        />
        <AutomationCard
          card={{
            id: "scheduled-1",
            title: "Weekly release digest",
            status: "blocked",
            instruction:
              "Summarize the week's releases and send me the digest.",
            trigger: "Every Friday at 09:00 · America/Los_Angeles",
            warning: "Connect your GitHub account to resume this automation.",
          }}
        />
      </Fixture>
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
    </GalleryShell>
  );
}

/** Render typed transcript tool states for visual regression and interaction checks. */
export function ToolCallGallery() {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-dashboard-border bg-dashboard-fill-faint">
      <div className="border-b border-dashboard-border-subtle px-2.5 py-1.5 font-mono text-xs text-dashboard-text-muted">
        Activity lane · click a row for arguments and result
      </div>
      <div className="grid min-w-0 gap-1 px-2 py-1.5">
        {TOOL_CALL_FIXTURES.map((fixture) => (
          <div className="grid min-w-0 gap-1" key={fixture.part.id}>
            <div className="font-mono text-2xs uppercase tracking-[0.08em] text-dashboard-text-muted">
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

function GalleryShell(props: {
  children: ReactNode;
  description: string;
  sectionId?: GallerySectionId;
  title: string;
}) {
  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-8 px-4 py-4 sm:px-8 sm:py-8",
      )}
    >
      <div className="grid min-w-0 gap-3">
        {props.sectionId ? (
          <Link
            className="w-fit font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
            to="/dev"
          >
            ← Component gallery
          </Link>
        ) : null}
        <PageHeader description={props.description} title={props.title} />
      </div>
      <div className="grid min-w-0 gap-6">{props.children}</div>
    </div>
  );
}

function Fixture(props: { children: ReactNode; title: string }) {
  return (
    <Card className="grid min-w-0 gap-3 p-4 sm:p-5" padding="none">
      <div className="border-b border-dashboard-border-subtle pb-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
        {props.title}
      </div>
      <div className="min-w-0">{props.children}</div>
    </Card>
  );
}

function TokenSwatchRow(props: {
  label: string;
  swatches: readonly { className: string; label: string }[];
}) {
  return (
    <div className="grid gap-2">
      <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </div>
      <div className="flex flex-wrap gap-3">
        {props.swatches.map((swatch) => (
          <div className="grid w-20 gap-1.5" key={swatch.label}>
            <div
              className={cn(
                "h-10 rounded-md border border-dashboard-border-subtle",
                swatch.className,
              )}
            />
            <div className="truncate font-mono text-2xs text-dashboard-text-muted">
              {swatch.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
