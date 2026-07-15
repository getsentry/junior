import { Duration } from "../../components/Duration";
import type { ReactNode } from "react";
import {
  Activity,
  Clock3,
  Coins,
  DollarSign,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";
import type { ConversationStatsReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Card } from "../../components/layout/Card";
import {
  formatCompactNumber,
  formatCostSummary,
  formatTime,
} from "../../format";
import { cn } from "../../styles";

/** Present 90-day runtime health as the primary System analytics surface. */
export function SystemActivity(props: {
  error: boolean;
  loading: boolean;
  stats: ConversationStatsReport | undefined;
}) {
  if (!props.stats) {
    return (
      <Card padding="sm">
        <EmptyTelemetry>
          {props.error
            ? "Conversation metrics failed to load."
            : props.loading
              ? "Loading conversation metrics."
              : "No conversation metrics have been reported yet."}
        </EmptyTelemetry>
      </Card>
    );
  }

  const stats = props.stats;
  const period = `${formatTime(stats.windowStart)} – ${formatTime(stats.windowEnd)}`;
  const completed = Math.max(
    0,
    stats.conversations - stats.active - stats.failed,
  );
  const terminal = completed + stats.failed;
  const completionRate = terminal
    ? Math.round((completed / terminal) * 100)
    : undefined;
  const distributionTotal = Math.max(1, stats.conversations);
  const distribution = [
    { className: "bg-cyan-300", label: "completed", value: completed },
    { className: "bg-emerald-300", label: "active", value: stats.active },
    { className: "bg-rose-300", label: "failed", value: stats.failed },
  ];

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4 max-sm:flex-col">
        <div>
          <div className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-cyan-200/65">
            90-day pulse
          </div>
          <h2 className="mt-1 mb-0 font-display text-xl font-medium tracking-[-0.02em] text-white">
            Runtime health
          </h2>
        </div>
        <div className="font-mono text-[0.63rem] leading-relaxed text-white/30 sm:text-right">
          <div>{period}</div>
          {props.error ? (
            <div className="mt-1 text-rose-200/65">
              Conversation metrics refresh failed. Showing cached data.
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(19rem,1.15fr)_minmax(0,1.85fr)]">
        <div className="border-b border-white/[0.06] bg-cyan-300/[0.035] p-5 lg:border-r lg:border-b-0 sm:p-6">
          <div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-display text-5xl font-light leading-none tracking-[-0.055em] text-white sm:text-6xl">
                  {formatCompactNumber(stats.conversations)}
                </div>
                <div className="mt-2 font-mono text-[0.64rem] uppercase tracking-[0.14em] text-white/40">
                  conversations
                </div>
              </div>
              <MessageSquare
                aria-hidden="true"
                className="text-cyan-200/45"
                size={24}
                strokeWidth={1.5}
              />
            </div>

            <div className="mt-8">
              <div className="mb-2 flex items-center justify-between font-mono text-[0.62rem] text-white/35">
                <span>Outcome mix</span>
                <span>
                  {completionRate === undefined
                    ? "No terminal outcomes"
                    : `${completionRate}% healthy completion`}
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.055]">
                {distribution.map((item) =>
                  item.value ? (
                    <div
                      className={item.className}
                      key={item.label}
                      style={{
                        width: `${(item.value / distributionTotal) * 100}%`,
                      }}
                    />
                  ) : null,
                )}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                {distribution.map((item) => (
                  <div key={item.label}>
                    <div className="flex items-center gap-1.5 font-display text-lg text-white/85">
                      <span
                        className={cn("size-1.5 rounded-full", item.className)}
                      />
                      {formatCompactNumber(item.value)}
                    </div>
                    <div className="mt-0.5 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-white/25">
                      {item.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2">
          <PulseMetric
            detail="Cumulative persisted runtime"
            icon={Clock3}
            label="runtime"
            value={<Duration value={stats.durationMs} />}
          />
          <PulseMetric
            detail="Across recorded model usage"
            icon={Coins}
            label="tokens"
            value={
              stats.tokens === undefined
                ? "—"
                : formatCompactNumber(stats.tokens)
            }
          />
          <PulseMetric
            detail="Estimated model spend"
            icon={DollarSign}
            label="estimated cost"
            value={
              stats.costUsd === undefined
                ? "—"
                : formatCostSummary({ total: stats.costUsd })
            }
          />
          <PulseMetric
            detail={`${terminal} terminal conversation${terminal === 1 ? "" : "s"}`}
            icon={stats.failed ? TriangleAlert : Activity}
            label="completion rate"
            tone={
              completionRate === undefined
                ? undefined
                : stats.failed
                  ? "warning"
                  : "good"
            }
            value={completionRate === undefined ? "—" : `${completionRate}%`}
          />
        </div>
      </div>
    </Card>
  );
}

function PulseMetric(props: {
  detail: string;
  icon: typeof Activity;
  label: string;
  tone?: "good" | "warning";
  value: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="min-w-0 border-b border-r border-white/[0.06] p-4 even:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-white/35">
          {props.label}
        </div>
        <Icon
          aria-hidden="true"
          className={cn(
            "text-cyan-200/40",
            props.tone === "good" && "text-emerald-200/55",
            props.tone === "warning" && "text-amber-200/55",
          )}
          size={15}
        />
      </div>
      <div className="mt-4 font-display text-3xl font-light leading-none tracking-[-0.04em] text-white">
        {props.value}
      </div>
      <div className="mt-2 font-mono text-[0.62rem] leading-relaxed text-white/30">
        {props.detail}
      </div>
    </div>
  );
}
