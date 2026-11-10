import type { ReplyGapSegmentsReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { ReplyGapHistogram } from "../../components/charts/ReplyGapHistogram";
import { Card } from "../../components/layout/Card";
import { SectionHeader } from "../../components/layout/SectionHeader";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { StatusChip } from "../../components/StatusChip";
import { formatCompactNumber } from "../../format";

/**
 * Show the gap list that the cache warming planner reads for each segment,
 * and whether the segment has enough gaps to warm.
 */
export function ReplyGapSegments(props: {
  error: boolean;
  report?: ReplyGapSegmentsReport;
}) {
  return (
    <Card as="section" className="mb-0" variant="section">
      <SectionHeader>
        <SectionTitle>Reply gaps</SectionTitle>
        <p className="mt-1 mb-0 font-sans text-xs leading-relaxed text-dashboard-text-muted">
          Time from the end of a Turn to the next request, by cache warming
          segment.
          {props.report
            ? ` A segment warms after ${props.report.minSamples} gaps.`
            : null}
        </p>
      </SectionHeader>
      {props.report ? (
        <SegmentGrid report={props.report} />
      ) : (
        <EmptyTelemetry>
          {props.error ? "Reply gaps failed to load." : "Loading reply gaps."}
        </EmptyTelemetry>
      )}
    </Card>
  );
}

function SegmentGrid(props: { report: ReplyGapSegmentsReport }) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-px bg-dashboard-border-subtle p-0 sm:grid-cols-2 xl:grid-cols-3">
      {props.report.segments.map(({ histogram, segment }) => (
        <li className="grid gap-3 bg-dashboard-surface-panel p-4" key={segment}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-mono text-xs text-dashboard-text">
              {segment}
            </span>
            {histogram.total >= props.report.minSamples ? (
              <StatusChip size="compact" tone="success">
                {formatCompactNumber(histogram.total)} gaps
              </StatusChip>
            ) : (
              <StatusChip size="compact" tone="warning">
                {histogram.total} of {props.report.minSamples} gaps
              </StatusChip>
            )}
          </div>
          <ReplyGapHistogram className="h-20" histogram={histogram} />
        </li>
      ))}
    </ul>
  );
}
