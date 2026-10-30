import type { ConversationMetricDay } from "@sentry/junior/api/schema";
import { ChevronRight } from "lucide-react";
import { formatCompactNumber } from "../../format";
import type { TimeRangeBucketUnit } from "../controls/TimeRangeSelector";
import { formatActivityTooltipDate } from "./ActivityChart";
import { cacheInputTotal, formatCacheShare } from "./cache-input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { dashboardDisclosureChevronClass } from "../../styles";

/** Identify the largest cache writes within the page's selected time window. */
export function CacheWrites(props: {
  days: ConversationMetricDay[];
  bucketUnit: TimeRangeBucketUnit;
}) {
  const ranked = props.days
    .filter((day) => (day.cacheCreationTokens ?? 0) > 0)
    .sort(
      (a, b) =>
        b.cacheCreationTokens! - a.cacheCreationTokens! ||
        b.date.localeCompare(a.date),
    )
    .slice(0, 3);
  if (!ranked.length) return null;
  const unit = props.bucketUnit === "6hour" ? "6 hours" : props.bucketUnit;
  return (
    <Collapsible className="border-t border-dashboard-border-subtle px-4 py-3 sm:px-5">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 font-sans tabular-nums text-xs text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus">
        <ChevronRight
          aria-hidden="true"
          className={dashboardDisclosureChevronClass}
        />
        Largest cache writes
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <p className="mb-2 mt-3 font-sans tabular-nums text-xs leading-relaxed text-dashboard-text-muted">
          Top three by tokens written per {unit}, within the selected time
          window. Large writes alone do not mean a cache problem.
        </p>
        <Table
          aria-label="Largest cache writes"
          className="min-w-80 table-fixed font-sans text-xs tabular-nums"
        >
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="px-0 py-2 font-normal">
                {props.bucketUnit === "day" ? "Day" : "Starting at"}
              </TableHead>
              <TableHead
                scope="col"
                className="w-24 px-0 py-2 text-right font-normal"
              >
                Written
              </TableHead>
              <TableHead
                scope="col"
                className="w-24 px-0 py-2 text-right font-normal"
              >
                From cache
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranked.map((day) => (
              <TableRow key={day.date}>
                <TableHead
                  scope="row"
                  className="px-0 py-2 font-normal whitespace-normal"
                >
                  {formatActivityTooltipDate(day.date)}
                </TableHead>
                <TableCell className="px-0 py-2 text-right whitespace-normal">
                  {formatCompactNumber(day.cacheCreationTokens)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right whitespace-normal">
                  {formatCacheShare(
                    day.cachedInputTokens,
                    cacheInputTotal(day),
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}
