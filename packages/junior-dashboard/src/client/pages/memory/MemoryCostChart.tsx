import {
  ActivityChartDateLabels,
  ActivityTooltipRows,
  createActivityChartLayout,
  formatActivityDate,
} from "../../components/charts/ActivityChart";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { Tooltip } from "../../components/Tooltip";
import { formatCostSummary } from "../../format";
import type { MemoryCostDay } from "./memoryDashboard";

/** Render stacked memory extraction and recall cost from durable plugin events. */
export function MemoryCostChart(props: {
  extractionDays: MemoryCostDay[];
  range: TimeRangeDays;
  recallDays: MemoryCostDay[];
}) {
  const recallByDate = new Map(props.recallDays.map((day) => [day.date, day]));
  const days = props.extractionDays.slice(-props.range).map((extraction) => ({
    date: extraction.date,
    extraction,
    recall: recallByDate.get(extraction.date) ?? {
      costUsd: 0,
      date: extraction.date,
      events: 0,
    },
  }));
  const extractionTotal = days.reduce(
    (sum, day) => sum + day.extraction.costUsd,
    0,
  );
  const recallTotal = days.reduce((sum, day) => sum + day.recall.costUsd, 0);
  const total = extractionTotal + recallTotal;
  const runs = days.reduce(
    (sum, day) => sum + day.extraction.events + day.recall.events,
    0,
  );
  const maximum = Math.max(
    0.01,
    ...days.map((day) => day.extraction.costUsd + day.recall.costUsd),
  );
  const layout = createActivityChartLayout(200);
  // Cost charts need a wider left gutter for currency tick labels.
  const left = 64;
  const plotWidth = layout.width - left - layout.right;
  const step = days.length > 0 ? plotWidth / days.length : plotWidth;
  const barWidth = Math.max(2, Math.min(13, step * 0.68));

  return (
    <Card className="min-h-[17rem] p-4 sm:p-5">
      <div>
        <h2 className="m-0 font-display text-xl font-medium text-dashboard-text">
          {formatCostSummary({ total })}
        </h2>
        <p className="mt-1 mb-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
          System-wide estimate across {formatRunCount(runs)} spanning extraction
          and recall.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-dashboard-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-[1px] bg-cyan-300"
            />
            Extraction {formatCostSummary({ total: extractionTotal })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-[1px] bg-fuchsia-400"
            />
            Recall {formatCostSummary({ total: recallTotal })}
          </span>
        </div>
      </div>

      <div className="relative mt-4 overflow-hidden">
        <svg
          aria-label={`Memory extraction and recall cost during the last ${props.range} days`}
          className="block h-auto min-h-40 w-full"
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          {[maximum, maximum / 2, 0].map((value, index) => {
            const y = layout.top + index * (layout.plotHeight / 2);
            return (
              <g key={index}>
                <line
                  stroke="rgba(255,255,255,0.07)"
                  strokeDasharray="3 5"
                  x1={left}
                  x2={layout.width - layout.right}
                  y1={y}
                  y2={y}
                />
                <text
                  fill="rgba(255,255,255,0.34)"
                  fontFamily="ui-monospace, monospace"
                  fontSize="12"
                  textAnchor="end"
                  x={left - 7}
                  y={y + 3}
                >
                  {formatCostSummary({ total: value })}
                </text>
              </g>
            );
          })}
          {days.map((day, index) => {
            const extractionHeight =
              (day.extraction.costUsd / maximum) * layout.plotHeight;
            const recallHeight =
              (day.recall.costUsd / maximum) * layout.plotHeight;
            const x = left + index * step + (step - barWidth) / 2;
            const dayTotal = day.extraction.costUsd + day.recall.costUsd;
            return (
              <Tooltip
                content={
                  <ActivityTooltipRows
                    rows={[
                      [
                        "extraction",
                        `${formatCostSummary({ total: day.extraction.costUsd })} · ${formatRunCount(day.extraction.events)}`,
                      ],
                      [
                        "recall",
                        `${formatCostSummary({ total: day.recall.costUsd })} · ${formatRunCount(day.recall.events)}`,
                      ],
                      ["total", formatCostSummary({ total: dayTotal })],
                    ]}
                  />
                }
                key={day.date}
                label={formatActivityDate(day.date)}
              >
                <g
                  aria-label={`${formatActivityDate(day.date)}: extraction ${formatCostSummary({ total: day.extraction.costUsd })}, ${formatRunCount(day.extraction.events)}; recall ${formatCostSummary({ total: day.recall.costUsd })}, ${formatRunCount(day.recall.events)}`}
                  tabIndex={0}
                >
                  <rect
                    fill="#67e8f9"
                    height={extractionHeight}
                    opacity={day.extraction.costUsd > 0 ? 0.82 : 0.1}
                    rx="1"
                    width={barWidth}
                    x={x}
                    y={layout.top + layout.plotHeight - extractionHeight}
                  />
                  <rect
                    fill="#e879f9"
                    height={recallHeight}
                    opacity={day.recall.costUsd > 0 ? 0.82 : 0.1}
                    rx="1"
                    width={barWidth}
                    x={x}
                    y={
                      layout.top +
                      layout.plotHeight -
                      extractionHeight -
                      recallHeight
                    }
                  />
                  <rect
                    fill="transparent"
                    height={layout.plotHeight}
                    width={Math.max(barWidth, 8)}
                    x={x - (Math.max(barWidth, 8) - barWidth) / 2}
                    y={layout.top}
                  />
                </g>
              </Tooltip>
            );
          })}
          <ActivityChartDateLabels
            dates={days.map((day) => day.date)}
            layout={{ ...layout, left }}
            xPosition={(index) => left + index * step + step / 2}
          />
        </svg>
        {runs === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center pt-12 font-mono text-xs text-dashboard-text-muted">
            No memory extraction or recall ran in this period.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function formatRunCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "run" : "runs"}`;
}
