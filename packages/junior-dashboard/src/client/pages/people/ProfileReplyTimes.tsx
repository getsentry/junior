import type { ReplyTimeHistogram as ReplyTimeHistogramReport } from "@sentry/junior/api/schema";

import { useState } from "react";
import { usePersonReplyTimesData } from "../../api";
import { ChartHeader } from "../../components/charts/ChartHeader";
import {
  ReplyTimeHistogram,
  replyTimeSummary,
} from "../../components/charts/ReplyTimeHistogram";
import {
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { Card } from "../../components/layout/Card";
import { SectionIntro } from "../../components/layout/SectionIntro";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { formatCompactNumber } from "../../format";

interface Row {
  histogram: ReplyTimeHistogramReport;
  id: string;
  label: string;
}

/**
 * Show the viewer's own reply times on their profile, in all and by the Turn
 * depth of the Conversation. The server returns them only to the profile's
 * person, so the profile renders this only then.
 */
export function ProfileReplyTimes(props: {
  email: string;
  range: TimeRangeDays;
}) {
  const [selected, setSelected] = useState("all");
  const query = usePersonReplyTimesData({
    days: props.range,
    email: props.email,
  });
  if (!query.data) return null;
  const { depths, histogram, partial } = query.data;
  const rows: Row[] = [
    { histogram, id: "all", label: "All" },
    ...depths.map((row) => ({
      histogram: row.histogram,
      id: row.depth,
      label: `${row.depth.replace("-", "–")} ${row.depth === "1" ? "Turn" : "Turns"}`,
    })),
  ];
  const current = rows.find((row) => row.id === selected) ?? rows[0]!;
  const summary = replyTimeSummary(current.histogram);
  return (
    <section
      aria-labelledby={anchorTitleId("reply-times")}
      className="grid gap-4"
    >
      <SectionIntro
        anchor="reply-times"
        description={`How long you take to send your next message after Junior answers, in the ${timeRangeDetail(props.range)}. Only you see this.${partial ? " Some Conversations had too much history to read, so they are left out." : ""}`}
        title="Your reply times"
      />
      <Card>
        <ChartHeader
          description={
            summary.noReplyShare
              ? `${formatCompactNumber(summary.replies)} replies within 55 minutes. ${summary.noReplyShare} of your replies came later.`
              : "No replies in this time window."
          }
          title={
            current.id === "all" ? "Replies" : `Replies after ${current.label}`
          }
          total={summary.median ?? "—"}
          totalLabel="typical reply"
        />
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Table className="table-fixed">
            <TableHeader className="bg-dashboard-overlay-soft">
              <TableRow>
                <TableHead className="pl-4 sm:pl-5" scope="col">
                  After
                </TableHead>
                <TableHead className="text-right" scope="col">
                  Replies
                </TableHead>
                <TableHead className="pr-4 text-right sm:pr-5" scope="col">
                  Typical
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const active = row.id === current.id;
                const rowSummary = replyTimeSummary(row.histogram);
                return (
                  <TableRow
                    className="cursor-pointer"
                    data-state={active ? "selected" : undefined}
                    key={row.id}
                    onClick={() => setSelected(row.id)}
                  >
                    <TableCell className="pl-4 text-xs sm:pl-5">
                      <button
                        aria-label={`Show replies: ${row.label}`}
                        aria-pressed={active}
                        className="cursor-pointer font-sans tabular-nums text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
                        type="button"
                      >
                        {row.label}
                      </button>
                    </TableCell>
                    <TableCell className="text-right font-sans text-xs tabular-nums">
                      {formatCompactNumber(rowSummary.replies)}
                    </TableCell>
                    <TableCell className="pr-4 text-right font-sans text-xs tabular-nums sm:pr-5">
                      {rowSummary.median ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-col border-dashboard-border-subtle px-2 py-3 max-lg:border-t lg:border-l">
            <ReplyTimeHistogram
              className="min-h-48 flex-1"
              histogram={current.histogram}
            />
          </div>
        </div>
      </Card>
    </section>
  );
}
