import { formatCompactNumber, formatMs } from "../format";
import type { ConversationStatsItem, ConversationStatsReport } from "../types";
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
  | "durationMs"
  | "failed"
  | "hung"
  | "locations"
  | "requesters"
  | "runs"
  | "tokens"
> = {
  active: 0,
  conversations: 0,
  durationMs: 0,
  failed: 0,
  hung: 0,
  locations: [],
  requesters: [],
  runs: 0,
};

/** Render aggregate conversation stats returned by the reporting API. */
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
      <div className="grid border-b border-white/10 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryMetric
          label="conversations"
          value={formatCompactNumber(stats.conversations)}
        />
        <SummaryMetric label="runs" value={formatCompactNumber(stats.runs)} />
        <SummaryMetric label="runtime" value={formatMs(stats.durationMs)} />
        <SummaryMetric
          label="tokens"
          value={stats.tokens ? formatCompactNumber(stats.tokens) : "0"}
        />
      </div>
      <div className="grid min-w-0 lg:grid-cols-2">
        <Leaderboard
          empty="No requester activity yet."
          items={stats.requesters}
          title="People"
        />
        <Leaderboard
          empty="No Slack destinations yet."
          items={stats.locations}
          title="Places"
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

function Leaderboard(props: {
  empty: string;
  items: ConversationStatsItem[];
  title: string;
}) {
  const items = props.items.slice(0, 5);
  return (
    <div className="min-w-0 border-r border-white/10 last:border-r-0 max-lg:border-t">
      <div className="border-b border-white/10 px-4 py-2.5 text-[0.76rem] font-bold uppercase leading-none text-[#888]">
        {props.title}
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-4 text-[0.84rem] leading-relaxed text-[#888]">
          {props.empty}
        </div>
      ) : (
        <ol className="m-0 list-none p-0">
          {items.map((item, index) => (
            <LeaderboardRow index={index} item={item} key={item.label} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LeaderboardRow(props: { index: number; item: ConversationStatsItem }) {
  const detail = [
    props.item.durationMs > 0 ? formatMs(props.item.durationMs) : undefined,
    props.item.tokens
      ? `${formatCompactNumber(props.item.tokens)} tokens`
      : undefined,
    props.item.failed > 0 ? plural("error", props.item.failed) : undefined,
    props.item.hung > 0
      ? `${formatCompactNumber(props.item.hung)} hung`
      : undefined,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <li className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 px-4 py-3 last:border-b-0">
      <div className="font-mono text-[0.74rem] font-semibold leading-none text-[#666]">
        {props.index + 1}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[0.92rem] font-semibold leading-tight text-white">
          {props.item.label}
        </div>
        <div className="mt-1 truncate text-[0.76rem] leading-tight text-[#888]">
          {detail || "No activity details"}
        </div>
      </div>
      <div className="text-right text-xl font-extrabold leading-none text-white">
        {formatCompactNumber(props.item.conversations)}
      </div>
    </li>
  );
}
