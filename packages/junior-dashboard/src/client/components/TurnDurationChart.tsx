import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { readConversationData } from "../api";
import {
  conversationIdForSession,
  conversationPath,
  formatMs,
  formatTokenTotal,
  requesterLabel,
  slackLocationLabel,
  turnToolCallCount,
  visualStatusForSession,
} from "../format";
import { cn } from "../styles";
import type { ConversationDetailFeed, Session, VisualStatus } from "../types";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import { SectionTitle } from "./SectionTitle";
import { statusBorderClass } from "./statusStyles";

/** Render recent turns by start time and duration. */
export function TurnDurationChart(props: {
  sessions: Session[];
  timeZone: string;
}) {
  const navigate = useNavigate();
  const nowMs = Date.now();
  const rangeStartMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const rangeEndMs = nowMs;
  const chartEdgePaddingMs = 6 * 60 * 60 * 1000;
  const chartRangeStartMs = rangeStartMs - chartEdgePaddingMs;
  const chartRangeEndMs = rangeEndMs + chartEdgePaddingMs;
  const points = props.sessions
    .map((session) => turnPoint(session, props.timeZone))
    .filter((point): point is TurnDurationPoint => Boolean(point))
    .filter((point) => point.x >= rangeStartMs && point.x <= rangeEndMs)
    .sort((left, right) => left.x - right.x);
  const totals = points.reduce(
    (sum, point) => ({
      failed: sum.failed + (point.status === "failed" ? 1 : 0),
      hung: sum.hung + (point.status === "hung" ? 1 : 0),
      total: sum.total + 1,
    }),
    { failed: 0, hung: 0, total: 0 },
  );
  const maxDurationMs = points.reduce(
    (max, point) => Math.max(max, point.durationMs),
    0,
  );
  const durationAxisMaxMs = Math.max(1000, Math.ceil(maxDurationMs * 1.12));
  const dayTicks = Array.from({ length: 7 }, (_, index) => {
    return rangeStartMs + index * 24 * 60 * 60 * 1000;
  });
  const openPoint = (point: TurnDurationPoint) => {
    navigate(conversationPath(conversationIdForSession(point.session)));
  };

  return (
    <Section>
      <SectionHeader
        actions={
          <div className="flex flex-wrap items-center gap-3 text-[0.78rem] font-semibold uppercase leading-none text-[#888]">
            <ChartLegendItem className="bg-[#b8b8b8]" label="Complete" />
            <ChartLegendItem className="bg-amber-400" label="Hung" />
            <ChartLegendItem className="bg-rose-400" label="Error" />
          </div>
        }
      >
        <SectionTitle>Turns</SectionTitle>
      </SectionHeader>
      <div
        className="min-h-48 px-3 pb-2 pt-4"
        aria-label="Turn duration over the last 7 days"
      >
        <ResponsiveContainer height={190} width="100%">
          <ScatterChart margin={{ bottom: 0, left: 0, right: 4, top: 14 }}>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.1)" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="x"
              domain={[chartRangeStartMs, chartRangeEndMs]}
              tickFormatter={(value) =>
                bucketLabel(Number(value), props.timeZone)
              }
              tick={{
                fill: "#888",
                fontFamily:
                  '-apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
                fontSize: 12,
              }}
              tickLine={false}
              ticks={dayTicks}
              type="number"
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              dataKey="durationMs"
              domain={[0, durationAxisMaxMs]}
              tickFormatter={(value) => formatMs(Number(value))}
              tick={{
                fill: "#888",
                fontFamily:
                  '-apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
                fontSize: 11,
              }}
              tickLine={false}
              type="number"
            />
            <Tooltip
              content={<TurnDurationTooltip />}
              cursor={{ stroke: "rgba(255, 255, 255, 0.22)" }}
            />
            <Scatter
              activeShape={durationDot(openPoint, true)}
              data={points}
              isAnimationActive={false}
              shape={durationDot(openPoint, false)}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-white/10 px-4 py-3 text-[0.84rem] leading-tight text-[#888]">
        {totals.total} turns / {totals.hung} hung / {totals.failed} errors
      </div>
    </Section>
  );
}

function ChartLegendItem(props: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", props.className)} />
      {props.label}
    </span>
  );
}

type PlottedTurnStatus = Exclude<VisualStatus, "active">;

type TurnDurationPoint = {
  durationMs: number;
  tooltipLabel: string;
  session: Session;
  status: PlottedTurnStatus;
  x: number;
};

function turnPoint(
  session: Session,
  timeZone: string,
): TurnDurationPoint | null {
  const startedAtMs = Date.parse(session.startedAt ?? "");
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  const status = visualStatusForSession(session);
  if (status === "active") {
    return null;
  }

  const lastSeenAtMs = Date.parse(session.lastSeenAt ?? "");
  const durationMs =
    session.cumulativeDurationMs ??
    (Number.isFinite(lastSeenAtMs)
      ? Math.max(0, lastSeenAtMs - startedAtMs)
      : 0);
  return {
    durationMs,
    session,
    status,
    tooltipLabel: new Date(startedAtMs).toLocaleString(undefined, {
      timeZone,
    }),
    x: startedAtMs,
  };
}

type DurationDotProps = {
  cx?: number;
  cy?: number;
  payload?: TurnDurationPoint;
};

function durationDot(
  onOpen: (point: TurnDurationPoint) => void,
  active: boolean,
) {
  return (props: DurationDotProps) => {
    if (props.cx == null || props.cy == null || !props.payload) {
      return <g />;
    }

    const point = props.payload;
    const fill = durationDotFill(point.status, active);
    return (
      <circle
        aria-label={`Open ${point.session.title ?? point.session.id}`}
        className="cursor-pointer outline-none transition-[filter,stroke,stroke-width] hover:brightness-125 focus-visible:stroke-emerald-400 focus-visible:stroke-2"
        cx={props.cx}
        cy={props.cy}
        fill={fill}
        onClick={() => onOpen(point)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(point);
          }
        }}
        r={active ? 5 : 4}
        role="link"
        stroke="rgba(0, 0, 0, 0.96)"
        strokeWidth={1}
        tabIndex={0}
      />
    );
  };
}

function durationDotFill(status: PlottedTurnStatus, active: boolean): string {
  if (status === "failed") {
    return active ? "rgba(251, 113, 133, 1)" : "rgba(244, 63, 94, 0.95)";
  }
  if (status === "hung") {
    return active ? "rgba(251, 191, 36, 1)" : "rgba(245, 158, 11, 0.94)";
  }
  return active ? "rgba(250, 250, 250, 0.96)" : "rgba(184, 184, 184, 0.82)";
}

function TurnDurationTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload: TurnDurationPoint }>;
}) {
  const point = props.payload?.[0]?.payload;
  const conversationId = point
    ? conversationIdForSession(point.session)
    : undefined;
  const detail = useQuery({
    enabled: Boolean(props.active && conversationId),
    queryKey: ["conversation", conversationId],
    queryFn: async () => readConversationData(conversationId!),
    retry: false,
    staleTime: 5_000,
  });

  if (!props.active || !point) {
    return null;
  }
  const rows = turnTooltipRows(point, detail.data);
  return (
    <div
      className={cn(
        "min-w-64 max-w-sm border border-l-4 border-white/15 bg-[#050505] px-3 py-2.5 text-[0.82rem] leading-relaxed text-[#b8b8b8]",
        statusBorderClass(point.status),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[0.92rem] font-bold leading-tight text-white">
            {turnTooltipTitle(point.session)}
          </div>
          <div className="mt-0.5 text-[0.78rem] leading-tight text-[#888]">
            {point.tooltipLabel}
          </div>
        </div>
        <span className={chartTooltipStatusClass(point.status)}>
          {point.status}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <span className="text-[0.72rem] font-semibold uppercase leading-relaxed text-[#777]">
              {label}
            </span>
            <span className="min-w-0 break-words text-right text-[#d6d6d6]">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function turnTooltipRows(
  point: TurnDurationPoint,
  detail: ConversationDetailFeed | undefined,
): Array<[string, string]> {
  const session = point.session;
  const requester = requesterLabel(
    session.requesterIdentity,
    session.requester,
  );
  const location = slackLocationLabel(session, { includeId: false });
  const tokens = formatTokenTotal(session.cumulativeUsage);
  return [
    ["duration", formatMs(point.durationMs)],
    tokens ? ["tokens", tokens] : null,
    ["tool calls", turnTooltipToolCalls(point, detail)],
    requester ? ["requester", requester] : null,
    location ? ["surface", location] : null,
  ].filter((row): row is [string, string] => Boolean(row));
}

function turnTooltipToolCalls(
  point: TurnDurationPoint,
  detail: ConversationDetailFeed | undefined,
): string {
  if (!detail) {
    return "loading";
  }
  const turn = detail.turns.find((item) => item.id === point.session.id);
  return String(turn ? turnToolCallCount(turn) : 0);
}

function turnTooltipTitle(session: Session): string {
  return (
    session.conversationTitle ??
    session.title ??
    conversationIdForSession(session)
  );
}

function chartTooltipStatusClass(status: PlottedTurnStatus): string {
  return cn(
    "shrink-0 text-[0.68rem] font-bold uppercase leading-none",
    status === "failed" && "text-rose-300",
    status === "hung" && "text-amber-300",
    status === "idle" && "text-[#b8b8b8]",
  );
}

function bucketLabel(timestampMs: number, timeZone: string): string {
  return new Date(timestampMs).toLocaleDateString(undefined, {
    timeZone,
    weekday: "short",
  });
}
