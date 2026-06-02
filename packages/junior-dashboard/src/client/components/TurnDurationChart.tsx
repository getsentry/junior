import { Fragment, useMemo, useState, type ReactNode } from "react";
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
  buildConversations,
  conversationDisplayTitle,
  conversationRequesterLabel,
  conversationIdForSession,
  conversationPath,
  formatConversationDuration,
  formatDurationTick,
  formatTurnDuration,
  requesterLabel,
  slackLocationLabel,
  summarizeMessages,
  summarizeToolCalls,
  summarizeUsage,
  turnElapsedDurationMs,
  visualStatusForSession,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type {
  Conversation,
  ConversationDetailFeed,
  ConversationTurn,
  Session,
  VisualStatus,
} from "../types";
import { MetricValue } from "./Metric";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import {
  DurationMetric,
  MessagesMetric,
  TokenMetric,
  ToolCallsMetric,
} from "./TelemetryMetrics";
import { statusBorderClass } from "./statusStyles";

/** Render recent turns by start time and duration. */
export function TurnDurationChart(props: {
  sessions: Session[];
  timeZone: string;
}) {
  const [mode, setMode] = useState<DurationChartMode>("conversations");
  const navigate = useNavigate();
  const nowMs = Date.now();
  const rangeStartMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const rangeEndMs = nowMs;
  const chartEdgePaddingMs = 6 * 60 * 60 * 1000;
  const chartRangeStartMs = rangeStartMs - chartEdgePaddingMs;
  const chartRangeEndMs = rangeEndMs + chartEdgePaddingMs;
  const conversations = useMemo(
    () => (mode === "conversations" ? buildConversations(props.sessions) : []),
    [mode, props.sessions],
  );
  const points = (
    mode === "turns"
      ? props.sessions.map((session) => turnPoint(session, props.timeZone))
      : conversations.map((conversation) =>
          conversationPoint(conversation, props.timeZone),
        )
  )
    .filter((point): point is DurationPoint => Boolean(point))
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
  const openPoint = (point: DurationPoint) => {
    navigate(conversationPath(point.conversationId));
  };
  const modeLabel = mode === "turns" ? "turns" : "conversations";

  return (
    <Section>
      <SectionHeader
        actions={
          <div className="flex flex-wrap items-center justify-end gap-3 text-[0.78rem] font-semibold uppercase leading-none text-[#888]">
            <ChartLegendItem className="bg-[#b8b8b8]" label="Complete" />
            <ChartLegendItem className="bg-amber-400" label="Hung" />
            <ChartLegendItem className="bg-rose-400" label="Error" />
          </div>
        }
      >
        <ChartModeToggle mode={mode} onChange={setMode} />
      </SectionHeader>
      <div
        className="min-h-48 px-3 pb-2 pt-4"
        aria-label={`${modeLabel} by duration over the last 7 days`}
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
              tickFormatter={(value) => formatDurationTick(Number(value))}
              tick={{
                fill: "#888",
                fontFamily:
                  '-apple-system, "system-ui", "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
                fontSize: 11,
              }}
              tickLine={false}
              type="number"
              width={48}
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
        {totals.total} {modeLabel} / {totals.hung} hung / {totals.failed} errors
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
type DurationChartMode = "conversations" | "turns";

type DurationPoint = {
  conversation?: Conversation;
  conversationId: string;
  durationLabel: string;
  durationMs: number;
  endedAt: string;
  kind: DurationChartMode;
  session?: Session;
  startedAt: string;
  status: PlottedTurnStatus;
  title: string;
  tooltipLabel: string;
  x: number;
};

function ChartModeToggle(props: {
  mode: DurationChartMode;
  onChange(mode: DurationChartMode): void;
}) {
  const modes: Array<{ label: string; value: DurationChartMode }> = [
    { label: "Conversations", value: "conversations" },
    { label: "Turns", value: "turns" },
  ];
  return (
    <div
      aria-label="Duration chart mode"
      className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
      role="group"
    >
      {modes.map((mode, index) => (
        <Fragment key={mode.value}>
          {index > 0 ? (
            <span className="text-[1.05rem] font-bold leading-tight text-[#666]">
              /
            </span>
          ) : null}
          <button
            aria-pressed={props.mode === mode.value}
            className={cn(
              "cursor-pointer border-0 bg-transparent p-0 text-[1.05rem] font-bold leading-tight tracking-normal transition-colors",
              props.mode === mode.value
                ? "text-white"
                : "text-[#888] hover:text-white",
            )}
            onClick={() => props.onChange(mode.value)}
            type="button"
          >
            {mode.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function plottedStatus(status: VisualStatus): PlottedTurnStatus | null {
  return status === "active" ? null : status;
}

function turnPoint(session: Session, timeZone: string): DurationPoint | null {
  const startedAtMs = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  const status = plottedStatus(visualStatusForSession(session));
  if (!status) {
    return null;
  }

  const durationMs = turnElapsedDurationMs(session);
  if (durationMs === undefined) {
    return null;
  }
  return {
    conversationId: conversationIdForSession(session),
    durationLabel: formatTurnDuration(session),
    durationMs,
    endedAt: session.completedAt ?? session.lastSeenAt,
    kind: "turns",
    session,
    startedAt: session.startedAt,
    status,
    title: turnTooltipTitle(session),
    tooltipLabel: new Date(startedAtMs).toLocaleString(undefined, {
      timeZone,
    }),
    x: startedAtMs,
  };
}

function conversationPoint(
  conversation: Conversation,
  timeZone: string,
): DurationPoint | null {
  const startedAtMs = Date.parse(conversation.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  const status = plottedStatus(visualStatusForConversation(conversation));
  if (!status) {
    return null;
  }
  const lastSeenAtMs = Date.parse(conversation.lastSeenAt);
  if (!Number.isFinite(lastSeenAtMs)) {
    return null;
  }
  const durationMs = Math.max(0, lastSeenAtMs - startedAtMs);

  return {
    conversation,
    conversationId: conversation.id,
    durationLabel: formatConversationDuration(conversation),
    durationMs,
    endedAt: conversation.lastSeenAt,
    kind: "conversations",
    startedAt: conversation.startedAt,
    status,
    title: conversationDisplayTitle(conversation),
    tooltipLabel: new Date(startedAtMs).toLocaleString(undefined, {
      timeZone,
    }),
    x: startedAtMs,
  };
}

type DurationDotProps = {
  cx?: number;
  cy?: number;
  payload?: DurationPoint;
};

function durationDot(onOpen: (point: DurationPoint) => void, active: boolean) {
  return (props: DurationDotProps) => {
    if (props.cx == null || props.cy == null || !props.payload) {
      return <g />;
    }

    const point = props.payload;
    const fill = durationDotFill(point.status, active);
    return (
      <circle
        aria-label={`Open ${point.title}`}
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
  payload?: Array<{ payload: DurationPoint }>;
}) {
  const point = props.payload?.[0]?.payload;
  const conversationId = point?.conversationId;
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
  const rows = chartTooltipRows(point, detail.data);
  return (
    <div
      className={cn(
        "min-w-64 max-w-sm border border-l-4 border-white/15 bg-[#050505] px-3 py-2.5 text-[0.82rem] leading-relaxed text-[#b8b8b8]",
        statusBorderClass(point.status),
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[0.92rem] font-bold leading-tight text-white">
            {point.title}
          </div>
          <div className="mt-0.5 text-[0.78rem] leading-tight text-[#888]">
            {point.tooltipLabel}
          </div>
        </div>
        {chartTooltipStatus(point.status)}
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

function chartTooltipRows(
  point: DurationPoint,
  detail: ConversationDetailFeed | undefined,
): Array<[string, ReactNode]> {
  const session = point.session ?? point.conversation;
  const requester =
    point.kind === "conversations"
      ? conversationRequesterLabel(point.conversation)
      : requesterLabel(session?.requesterIdentity);
  const location = session
    ? slackLocationLabel(session, { includeId: false })
    : undefined;
  const turns = chartTooltipTurns(point, detail);
  const tokenSummary = summarizeUsage(
    point.kind === "turns"
      ? [point.session?.cumulativeUsage]
      : (detail?.turns ?? point.conversation?.turns ?? []).map(
          (turn) => turn.cumulativeUsage,
        ),
  );
  const messageSummary = detail ? summarizeMessages(turns) : undefined;
  const toolSummary = detail ? summarizeToolCalls(turns) : undefined;
  const rows: Array<[string, ReactNode] | null> = [
    [
      "duration",
      <DurationMetric
        align="right"
        endedAt={point.endedAt}
        label={point.durationLabel}
        startedAt={point.startedAt}
      />,
    ],
    tokenSummary
      ? ["tokens", <TokenMetric align="right" summary={tokenSummary} />]
      : null,
    [
      "messages",
      detail ? <MessagesMetric summary={messageSummary} /> : "loading",
    ],
    !detail || (toolSummary && toolSummary.total > 0)
      ? [
          "tool calls",
          detail ? (
            <ToolCallsMetric align="right" summary={toolSummary} />
          ) : (
            "loading"
          ),
        ]
      : null,
    requester ? ["requester", requester] : null,
    location ? ["surface", location] : null,
  ];
  return rows.filter((row): row is [string, ReactNode] => row !== null);
}

function chartTooltipTurns(
  point: DurationPoint,
  detail: ConversationDetailFeed | undefined,
): ConversationTurn[] {
  if (point.kind === "conversations") {
    return detail?.turns ?? [];
  }
  const turn = detail?.turns.find((item) => item.id === point.session?.id);
  return turn ? [turn] : [];
}

function turnTooltipTitle(session: Session): string {
  return session.conversationTitle ?? session.title;
}

function chartTooltipStatus(status: PlottedTurnStatus): ReactNode {
  if (status === "idle") {
    return null;
  }
  return (
    <MetricValue
      className={cn(
        "shrink-0 text-[0.68rem] font-bold uppercase leading-none",
        status === "failed" && "text-rose-300",
        status === "hung" && "text-amber-300",
      )}
    >
      {status === "failed" ? "error" : status}
    </MetricValue>
  );
}

function bucketLabel(timestampMs: number, timeZone: string): string {
  return new Date(timestampMs).toLocaleDateString(undefined, {
    timeZone,
    weekday: "short",
  });
}
