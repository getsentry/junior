import type { ConversationMetricDay } from "@sentry/junior/api/schema";
import { formatCompactNumber } from "../../format";
import type { TimeRangeBucketUnit } from "../controls/TimeRangeSelector";
import { formatActivityTooltipDate } from "./ActivityChart";
import { cacheInputTotal, formatCacheShare } from "./cache-input";

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
    <details className="border-t border-dashboard-border-subtle px-4 py-3 sm:px-5">
      <summary className="cursor-pointer font-mono text-xs text-dashboard-text focus-visible:outline focus-visible:outline-cyan-300">
        Largest cache writes
      </summary>
      <p className="mb-2 mt-3 font-mono text-xs leading-relaxed text-dashboard-text-muted">
        Top three by tokens written per {unit}, within the selected time window.
        Large writes alone do not mean a cache problem.
      </p>
      <div className="overflow-x-auto">
        <table
          aria-label="Largest cache writes"
          className="w-full min-w-80 table-fixed border-collapse font-mono text-xs tabular-nums"
        >
          <thead className="text-dashboard-text-muted">
            <tr>
              <th scope="col" className="py-2 text-left font-normal">
                {props.bucketUnit === "day" ? "Day" : "Starting at"}
              </th>
              <th scope="col" className="w-24 py-2 text-right font-normal">
                Written
              </th>
              <th scope="col" className="w-24 py-2 text-right font-normal">
                From cache
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((day) => (
              <tr
                key={day.date}
                className="border-t border-dashboard-border-subtle"
              >
                <th
                  scope="row"
                  className="py-2 text-left font-normal text-dashboard-text-muted"
                >
                  {formatActivityTooltipDate(day.date)}
                </th>
                <td className="py-2 text-right text-dashboard-text">
                  {formatCompactNumber(day.cacheCreationTokens)}
                </td>
                <td className="py-2 text-right text-dashboard-text">
                  {formatCacheShare(
                    day.cachedInputTokens,
                    cacheInputTotal(day),
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
