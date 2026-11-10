import type { ReplyGapSegmentsReport } from "@sentry/junior/api/schema";

import { useState } from "react";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { ChartHeader } from "../../components/charts/ChartHeader";
import { ReplyGapHistogram } from "../../components/charts/ReplyGapHistogram";
import { Card } from "../../components/layout/Card";
import { StatusChip } from "../../components/StatusChip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { formatCompactNumber } from "../../format";
import { cn } from "../../styles";

type Segment = ReplyGapSegmentsReport["segments"][number];

// The first part of a segment: who started the Turn, or `archived`.
const GROUPS = [
  { label: "People", value: "user" },
  { label: "System", value: "system" },
  { label: "Archived", value: "archived" },
] as const;
type Group = (typeof GROUPS)[number]["value"];

function segmentParts(segment: string) {
  const parts = segment.split(":");
  return parts[0] === "archived"
    ? { group: parts[0], turns: "Any", work: parts[1] ?? "" }
    : { group: parts[0], turns: parts[1] ?? "", work: parts[2] ?? "" };
}

function replyShare(segment: Segment): string {
  const { noReply, total } = segment.histogram;
  return total ? `${Math.round(((total - noReply) / total) * 100)}%` : "—";
}

function busiest(segments: Segment[]): string | undefined {
  return segments.reduce<Segment | undefined>(
    (best, segment) =>
      !best || segment.histogram.total > best.histogram.total ? segment : best,
    undefined,
  )?.segment;
}

/**
 * Show the gap list that the cache warming planner reads for each segment,
 * one group at a time, with the histogram of the selected segment.
 */
export function ReplyGapSegments(props: {
  error: boolean;
  report?: ReplyGapSegmentsReport;
}) {
  const [group, setGroup] = useState<Group>("user");
  const [selected, setSelected] = useState<string>();
  const minSamples = props.report?.minSamples ?? 0;
  const segments = (props.report?.segments ?? []).filter(
    (segment) => segmentParts(segment.segment).group === group,
  );
  const current =
    segments.find((segment) => segment.segment === selected) ??
    segments.find((segment) => segment.segment === busiest(segments));

  return (
    <Card>
      <ChartHeader
        description={
          props.report
            ? `Time from the end of a Turn to the next request. The planner warms a segment after ${minSamples} gaps.`
            : undefined
        }
        title="Reply gaps"
        trailing={
          <ToggleGroup
            aria-label="Segment group"
            onValueChange={([next]) => {
              if (next) setGroup(next as Group);
            }}
            value={[group]}
          >
            {GROUPS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      {!props.report ? (
        <EmptyTelemetry>
          {props.error ? "Reply gaps failed to load." : "Loading reply gaps."}
        </EmptyTelemetry>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Table className="table-fixed">
            <TableHeader className="bg-dashboard-overlay-soft">
              <TableRow>
                <TableHead className="pl-4 sm:pl-5" scope="col">
                  Turns
                </TableHead>
                <TableHead scope="col">Work</TableHead>
                <TableHead className="text-right" scope="col">
                  Gaps
                </TableHead>
                <TableHead className="pr-4 text-right sm:pr-5" scope="col">
                  Replied
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((segment) => {
                const parts = segmentParts(segment.segment);
                const active = segment.segment === current?.segment;
                const ready = segment.histogram.total >= minSamples;
                return (
                  <TableRow
                    className="cursor-pointer"
                    data-state={active ? "selected" : undefined}
                    key={segment.segment}
                    onClick={() => setSelected(segment.segment)}
                  >
                    <TableCell className="pl-4 text-xs sm:pl-5">
                      <button
                        aria-label={`Show ${segment.segment}`}
                        aria-pressed={active}
                        className="cursor-pointer font-sans tabular-nums text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
                        type="button"
                      >
                        {parts.turns}
                      </button>
                    </TableCell>
                    <TableCell className="text-xs capitalize">
                      {parts.work}
                    </TableCell>
                    <TableCell className="text-right font-sans text-xs tabular-nums">
                      {ready ? (
                        formatCompactNumber(segment.histogram.total)
                      ) : (
                        <StatusChip
                          className="ml-auto"
                          size="compact"
                          tone="warning"
                        >
                          {segment.histogram.total} of {minSamples}
                        </StatusChip>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "pr-4 text-right font-sans text-xs tabular-nums sm:pr-5",
                        !ready && "text-dashboard-text-muted",
                      )}
                    >
                      {replyShare(segment)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-col gap-2 border-dashboard-border-subtle px-2 py-3 max-lg:border-t lg:border-l">
            {current ? (
              <>
                <div className="flex items-baseline justify-between gap-3 px-2 font-sans text-xs text-dashboard-text-muted">
                  <span className="font-mono text-dashboard-text">
                    {current.segment}
                  </span>
                  <span>
                    {current.histogram.total < minSamples
                      ? "Too few gaps to warm"
                      : `${formatCompactNumber(current.histogram.total)} gaps`}
                  </span>
                </div>
                <ReplyGapHistogram
                  className="min-h-48 flex-1"
                  histogram={current.histogram}
                />
              </>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  );
}
