import { formatCompactNumber, formatCostSummary, formatMs } from "../format";
import type { ConversationStatsReport } from "@sentry/junior/api/schema";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import { SectionTitle } from "./SectionTitle";

function plural(label: string, count: number): string {
  return `${formatCompactNumber(count)} ${label}${count === 1 ? "" : "s"}`;
}

const EMPTY_STATS: Pick<
  ConversationStatsReport,
  | "active"
  | "conversations"
  | "costUsd"
  | "durationMs"
  | "failed"
  | "hung"
  | "tokens"
> = {
  active: 0,
  conversations: 0,
  durationMs: 0,
  failed: 0,
  hung: 0,
};

/** Render aggregate conversation stats returned by the REST API. */
export function ConversationStats(props: {
  stats?: ConversationStatsReport;
  statsError?: boolean;
  statsLoading?: boolean;
}) {
  const stats = props.stats ?? EMPTY_STATS;
  const stateLabel = props.statsError
    ? "degraded"
    : props.statsLoading
      ? "loading"
      : props.stats?.truncated
        ? "limited sample"
        : undefined;

  return (
    <Section>
      <SectionHeader
        actions={
          stateLabel ? (
            <div className="text-right text-[0.76rem] font-semibold uppercase leading-tight text-[#888]">
              {stateLabel}
            </div>
          ) : null
        }
      >
        <SectionTitle>Stats</SectionTitle>
      </SectionHeader>
      <div className="grid border-b border-white/10 sm:grid-cols-4">
        <SummaryMetric
          label="conversations"
          value={formatCompactNumber(stats.conversations)}
        />
        <SummaryMetric label="runtime" value={formatMs(stats.durationMs)} />
        <SummaryMetric
          label="tokens"
          value={stats.tokens ? formatCompactNumber(stats.tokens) : "0"}
        />
        <SummaryMetric
          label="cost"
          value={
            formatCostSummary(
              stats.costUsd === undefined
                ? undefined
                : { total: stats.costUsd },
            ) || "$0.00"
          }
        />
      </div>
      <div className="border-t border-white/10 px-4 py-3 text-[0.84rem] leading-tight text-[#888]">
        {stats.active} active / {stats.hung} hung /{" "}
        {plural("error", stats.failed)}
      </div>
    </Section>
  );
}

function SummaryMetric(props: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-t border-white/10 bg-[#050505] px-4 py-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 lg:border-t-0">
      <div className="truncate text-2xl font-extrabold leading-none text-white">
        {props.value}
      </div>
      <div className="mt-1 text-[0.72rem] font-semibold uppercase leading-tight text-[#888]">
        {props.label}
      </div>
    </div>
  );
}
