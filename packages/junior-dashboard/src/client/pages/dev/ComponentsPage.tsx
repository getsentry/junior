import type { ReactNode } from "react";

import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
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

/** Config-gated visual fixtures for dashboard transcript components. */
export function ComponentsPage() {
  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        description="Fixtures for transcript markdown and related components."
        eyebrow="Development"
        title="Components"
      />
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
    </div>
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
