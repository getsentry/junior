import { cn } from "../styles";
import { ShimmerText } from "../components/ShimmerText";

export type UsageCardRow = {
  label: string;
  live?: boolean;
  /** Render the label in the code face, such as a model id. */
  code?: boolean;
  value: string;
};

export type UsageCardSection = {
  /** Rows rolled up into one "N more" line, with their combined value. */
  more?: { count: number; value: string };
  rows: UsageCardRow[];
  title: string;
  /** Section total shown after the title, such as all auxiliary cost. */
  total?: string;
};

export type UsageCardSplit = {
  count: number;
  self: string;
  /** Share of the total that belongs to this agent, from 0 to 1. */
  selfShare: number;
  subagents: string;
};

export type UsageCardProps = {
  /** Closing hint, such as where to find the full breakdown. */
  footer?: string;
  /** Muted detail after the title, such as a compaction count. */
  note?: string;
  sections: UsageCardSection[];
  split?: UsageCardSplit;
  title: string;
  total: string;
};

const SELF_FILL = "bg-dashboard-focus/80";
const SUBAGENT_FILL = "bg-dashboard-focus/30";

function Swatch(props: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-xs", props.className)}
    />
  );
}

/**
 * Summarize one usage total: the total up top, how it splits between this
 * agent and its subagents, then the largest contributors. Long lists roll
 * their tail into one "N more" row so the card never needs to scroll.
 */
export function UsageCard(props: UsageCardProps) {
  const selfPercent = Math.min(
    100,
    Math.max(0, (props.split?.selfShare ?? 1) * 100),
  );
  return (
    <span className="grid gap-3">
      <span
        className={cn(
          "grid gap-2.5",
          (props.sections.length > 0 || props.footer) &&
            "border-b border-dashboard-border pb-3",
        )}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">
            {props.title}
            {props.note ? (
              <span className="text-dashboard-text-faint"> · {props.note}</span>
            ) : null}
          </span>
          <span className="whitespace-nowrap text-lg font-semibold tabular-nums text-dashboard-text">
            {props.total}
          </span>
        </span>
        {props.split ? (
          <>
            <span
              aria-hidden="true"
              className="flex h-1.5 overflow-hidden rounded-full bg-dashboard-fill-hover"
            >
              <span
                className={SELF_FILL}
                style={{ width: `${selfPercent}%` }}
              />
              <span
                className={SUBAGENT_FILL}
                style={{ width: `${100 - selfPercent}%` }}
              />
            </span>
            <span className="flex flex-wrap justify-between gap-x-3 gap-y-1 tabular-nums">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Swatch className={SELF_FILL} />
                this agent
                <span className="font-medium text-dashboard-text">
                  {props.split.self}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Swatch className={SUBAGENT_FILL} />
                {props.split.count} subagent{props.split.count === 1 ? "" : "s"}
                <span className="font-medium text-dashboard-text">
                  {props.split.subagents}
                </span>
              </span>
            </span>
          </>
        ) : null}
      </span>
      {props.sections.map((section) => (
        <span
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2"
          key={section.title}
        >
          <span className="col-span-2 font-sans font-medium text-dashboard-text-faint">
            {section.title}
            {section.total ? ` · ${section.total}` : null}
          </span>
          {section.rows.map((row) => (
            <span className="contents" key={row.label}>
              <span
                className={cn(
                  "flex min-w-0 items-baseline gap-2",
                  row.code && "font-mono text-dashboard-text",
                )}
              >
                <span className="min-w-0 truncate" title={row.label}>
                  {row.label}
                </span>
                {row.live ? (
                  <span className="shrink-0 font-sans text-2xs text-dashboard-text-muted">
                    <ShimmerText active>in progress</ShimmerText>
                  </span>
                ) : null}
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-dashboard-text">
                {row.value}
              </span>
            </span>
          ))}
          {section.more ? (
            <>
              <span className="text-dashboard-text-faint">
                {section.more.count} more
              </span>
              <span className="whitespace-nowrap text-right tabular-nums">
                {section.more.value}
              </span>
            </>
          ) : null}
        </span>
      ))}
      {props.footer ? (
        <span
          className={cn(
            "text-dashboard-text-faint",
            props.sections.length > 0 &&
              "border-t border-dashboard-border pt-3",
          )}
        >
          {props.footer}
        </span>
      ) : null}
    </span>
  );
}
