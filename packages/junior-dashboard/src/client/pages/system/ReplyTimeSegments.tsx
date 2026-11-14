import type { ReplyTimeSegmentsReport } from "@sentry/junior/api/schema";

import { useState } from "react";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { ChartHeader } from "../../components/charts/ChartHeader";
import {
  ReplyTimeHistogram,
  replyTimeSummary,
} from "../../components/charts/ReplyTimeHistogram";
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

type Segment = ReplyTimeSegmentsReport["segments"][number];

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

// A thin segment leans on the `none` segment with the same Actor and Turn
// depth, as `parentGapSegment` in the cache warming model. Only a non-archived
// `none` segment has none to lean on.
function hasParent(segment: string): boolean {
  const parts = segmentParts(segment);
  return parts.group === "archived" || parts.work !== "none";
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
export function ReplyTimeSegments(props: {
  error: boolean;
  report?: ReplyTimeSegmentsReport | undefined;
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
  const currentSummary = current && replyTimeSummary(current.histogram);

  return (
    <Card>
      <ChartHeader
        description={
          props.report
            ? `Time until the next message after a Turn ends, by cache warming segment. A segment with fewer than ${minSamples} samples uses the samples of its "none" segment.`
            : undefined
        }
        title="Reply times"
        trailing={
          <ToggleGroup
            aria-label="Segment group"
            onValueChange={([next]) => {
              if (next) setGroup(next);
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
          {props.error ? "Reply times failed to load." : "Loading reply times."}
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
                  Samples
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
                      ? hasParent(current.segment)
                        ? `Uses its "none" segment until ${minSamples} samples`
                        : "Too few samples to warm"
                      : currentSummary?.median
                        ? `Typical reply ${currentSummary.median}`
                        : "No replies"}
                  </span>
                </div>
                <ReplyTimeHistogram
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
