import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  conversationDisplayTitle,
  conversationIdForSession,
  conversationIdentityMeta,
  conversationPath,
  formatMs,
  formatRelativeTime,
  formatTime,
  isFailedSession,
  slackLocationLabel,
  visualStatusForConversation,
  visualStatusForSession,
} from "./format";
import { cn } from "./styles";
import type {
  Conversation,
  DashboardData,
  Session,
  SessionFilter,
  VisualStatus,
} from "./types";

/** Render the compact Junior wordmark used by the dashboard shell. */
export function JuniorLogo() {
  return (
    <div className="grid size-9 shrink-0 place-items-center bg-black font-mono text-[0.82rem] font-black leading-none text-white">
      Jr
    </div>
  );
}

/** Frame a dashboard content region without leaking CSS class contracts. */
export function Section(props: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "mb-4 min-w-0 border border-slate-800 bg-neutral-900/80",
        props.className,
      )}
    >
      {props.children}
    </section>
  );
}

/** Render a dashboard section heading row with optional controls. */
export function SectionHeader(props: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-neutral-950/60 px-4 py-3 max-md:flex-col max-md:items-stretch">
      <div className="min-w-0">{props.children}</div>
      {props.actions ? (
        <div className="shrink-0 max-md:w-full">{props.actions}</div>
      ) : null}
    </div>
  );
}

/** Render small uppercase dashboard context labels consistently. */
export function Kicker(props: { children: ReactNode }) {
  return (
    <div className="font-mono text-[0.78rem] uppercase leading-tight text-slate-400">
      {props.children}
    </div>
  );
}

/** Render compact section titles that fit inside operational panels. */
export function SectionTitle(props: { children: ReactNode }) {
  return (
    <div className="mt-1 text-[1.05rem] font-bold leading-tight tracking-normal">
      {props.children}
    </div>
  );
}

/** Render the full-page loading treatment before the first dashboard payload lands. */
export function LoadingView(props: { label: string }) {
  return (
    <div className="grid min-h-[calc(100vh-5rem)] place-items-center px-4 py-8 md:px-8">
      <section className="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-slate-700 bg-neutral-900/80 p-4">
        <JuniorLogo />
        <div>
          <div className="font-bold">{props.label}</div>
          <div className="mt-3 h-1.5 w-full animate-pulse bg-slate-600" />
        </div>
      </section>
    </div>
  );
}

/** Render the shared active/idle visual indicator without duplicating status text. */
export function ActivityIndicator(props: {
  status: VisualStatus | undefined;
  variant?: "compact" | "full";
}) {
  const activity = props.status ?? "idle";
  if (props.variant !== "full" && activity === "idle") {
    return null;
  }
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[0.78rem] font-bold uppercase leading-none tracking-normal",
        props.variant === "full" ? "w-full justify-end" : "",
        activity === "active" && "text-emerald-400",
        activity === "hung" && "text-amber-400",
        activity === "failed" && "text-rose-400",
        activity === "idle" && "text-slate-500",
      )}
      aria-label={activity}
    >
      <span
        className={cn(
          "size-2.5 shrink-0 border",
          activity === "active" && "border-emerald-400 bg-emerald-400",
          activity === "hung" && "border-amber-400 bg-amber-400",
          activity === "failed" && "border-rose-400 bg-rose-400",
          activity === "idle" && "border-slate-500 bg-transparent",
        )}
      />
    </div>
  );
}

/** Render the command-center summary rail from the dashboard health payload. */
export function CommandRail(props: {
  data?: DashboardData;
  error: Error | null;
}) {
  const sessions = props.data?.sessions.sessions ?? [];
  const activeSessions = sessions.filter(
    (session) => visualStatusForSession(session) === "active",
  );
  const hungSessions = sessions.filter(
    (session) => visualStatusForSession(session) === "hung",
  );
  const failedSessions = sessions.filter(isFailedSession);

  return (
    <aside className="min-w-0">
      <Section>
        <SectionHeader
          actions={
            <div className="inline-flex items-center gap-1.5 font-mono text-[0.82rem] leading-none text-emerald-400">
              <span className="size-2 bg-emerald-400" />
              <span>
                {props.error ? "degraded" : props.data ? "online" : "checking"}
              </span>
            </div>
          }
        >
          <Kicker>Command Center</Kicker>
          <SectionTitle>Pulse</SectionTitle>
        </SectionHeader>
        <div className="px-4 py-4">
          <div className="text-6xl font-black leading-none text-emerald-400 md:text-7xl">
            {props.error
              ? "ERR"
              : (props.data?.health.status.toUpperCase() ?? "...")}
          </div>
          <div className="mt-3 break-words font-mono text-[0.84rem] leading-relaxed text-slate-400">
            {props.error
              ? props.error.message
              : props.data
                ? `${props.data.health.service} / ${formatTime(props.data.health.timestamp)}`
                : "Waiting for Junior telemetry."}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-slate-800 bg-slate-800">
          <Stat label="plugins" value={props.data?.plugins.length ?? 0} />
          <Stat label="skills" value={props.data?.skills.length ?? 0} />
          <Stat label="active" value={activeSessions.length} />
          <Stat label="hung" value={hungSessions.length} />
          <Stat label="failed" value={failedSessions.length} />
        </div>
      </Section>
    </aside>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div className="min-w-0 bg-neutral-950/80 px-3 py-3">
      <div className="text-2xl font-extrabold leading-none text-slate-100">
        {props.value}
      </div>
      <div className="mt-1 font-mono text-[0.78rem] uppercase leading-tight text-slate-400">
        {props.label}
      </div>
    </div>
  );
}

/** Render recent turns by start time and duration. */
export function TurnDurationChart(props: {
  sessions: Session[];
  timeZone: string;
}) {
  const navigate = useNavigate();
  const nowMs = Date.now();
  const rangeStartMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const rangeEndMs = nowMs;
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
          <div className="flex flex-wrap items-center gap-3 font-mono text-[0.78rem] uppercase leading-none text-slate-400">
            <ChartLegendItem className="bg-slate-400" label="Complete" />
            <ChartLegendItem className="bg-amber-400" label="Hung" />
            <ChartLegendItem className="bg-rose-400" label="Error" />
          </div>
        }
      >
        <Kicker>7 Day Duration</Kicker>
        <SectionTitle>Turns</SectionTitle>
      </SectionHeader>
      <div
        className="min-h-48 px-3 pb-2 pt-4"
        aria-label="Turn duration over the last 7 days"
      >
        <ResponsiveContainer height={190} width="100%">
          <LineChart
            data={points}
            margin={{ bottom: 0, left: 0, right: 4, top: 14 }}
          >
            <CartesianGrid stroke="rgba(71, 85, 105, 0.35)" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="x"
              domain={[rangeStartMs, rangeEndMs]}
              tickFormatter={(value) =>
                bucketLabel(Number(value), props.timeZone)
              }
              tick={{
                fill: "#94a3b8",
                fontFamily: "ui-monospace",
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
              tickFormatter={(value) => formatMs(Number(value))}
              tick={{
                fill: "#94a3b8",
                fontFamily: "ui-monospace",
                fontSize: 11,
              }}
              tickLine={false}
              type="number"
            />
            <Tooltip
              content={<TurnDurationTooltip />}
              cursor={{ stroke: "rgba(71, 85, 105, 0.55)" }}
            />
            <Line
              activeDot={durationDot("rgba(203, 213, 225, 0.95)", 5, openPoint)}
              dataKey="completeDurationMs"
              dot={durationDot("rgba(148, 163, 184, 0.78)", 4, openPoint)}
              isAnimationActive={false}
              stroke="transparent"
            />
            <Line
              activeDot={durationDot("rgba(251, 191, 36, 1)", 5, openPoint)}
              dataKey="hungDurationMs"
              dot={durationDot("rgba(245, 158, 11, 0.94)", 4, openPoint)}
              isAnimationActive={false}
              stroke="transparent"
            />
            <Line
              activeDot={durationDot("rgba(251, 113, 133, 1)", 5, openPoint)}
              dataKey="failedDurationMs"
              dot={durationDot("rgba(244, 63, 94, 0.95)", 4, openPoint)}
              isAnimationActive={false}
              stroke="transparent"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="border-t border-slate-800 px-4 py-3 font-mono text-[0.8rem] leading-tight text-slate-400">
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
  completeDurationMs?: number;
  durationMs: number;
  failedDurationMs?: number;
  hungDurationMs?: number;
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
  const point: TurnDurationPoint = {
    durationMs,
    session,
    status,
    tooltipLabel: new Date(startedAtMs).toLocaleString(undefined, {
      timeZone,
    }),
    x: startedAtMs,
  };
  if (status === "failed") {
    point.failedDurationMs = durationMs;
  } else if (status === "hung") {
    point.hungDurationMs = durationMs;
  } else {
    point.completeDurationMs = durationMs;
  }
  return point;
}

type DurationDotProps = {
  cx?: number;
  cy?: number;
  payload?: TurnDurationPoint;
};

function durationDot(
  fill: string,
  radius: number,
  onOpen: (point: TurnDurationPoint) => void,
) {
  return (props: DurationDotProps) => {
    if (props.cx == null || props.cy == null || !props.payload) {
      return null;
    }

    const point = props.payload;
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
        r={radius}
        role="link"
        stroke="rgba(12, 19, 32, 0.92)"
        strokeWidth={1}
        tabIndex={0}
      />
    );
  };
}

function TurnDurationTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload: TurnDurationPoint }>;
}) {
  const point = props.payload?.[0]?.payload;
  if (!props.active || !point) {
    return null;
  }
  return (
    <div className="border border-slate-700 bg-neutral-950/95 px-3 py-2 font-mono text-[0.78rem] leading-relaxed text-slate-400 shadow-xl shadow-black/40">
      <div className="mb-1 text-slate-100">{point.tooltipLabel}</div>
      <div className="font-bold text-slate-100">
        {formatMs(point.durationMs)}
      </div>
      <div>{point.status}</div>
      <div>{point.session.title ?? point.session.id}</div>
    </div>
  );
}

/** Render conversation filters while keeping URL state owned by the page. */
export function FilterTabs(props: {
  current: SessionFilter;
  onChange(filter: SessionFilter): void;
}) {
  const filters: SessionFilter[] = [
    "recent",
    "active",
    "hung",
    "failed",
    "all",
  ];
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {filters.map((filter) => (
        <button
          className={cn(
            "cursor-pointer border px-2 py-1 font-mono text-[0.78rem] uppercase leading-tight transition-colors",
            props.current === filter
              ? "border-slate-500 bg-slate-800 text-white"
              : "border-slate-800 bg-neutral-900 text-slate-400 hover:border-slate-600 hover:text-white",
          )}
          key={filter}
          onClick={() => props.onChange(filter)}
          type="button"
        >
          {filter}
        </button>
      ))}
    </div>
  );
}

/** Render the full conversation table used by the conversations page. */
export function ConversationList(props: {
  conversations: Conversation[];
  selectedId?: string;
  search?: string;
}) {
  if (props.conversations.length === 0) {
    return (
      <div className="grid gap-2 p-3">
        <EmptyTelemetry>No matching conversation telemetry.</EmptyTelemetry>
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-auto" role="table">
      <div
        className="sticky top-0 z-[1] grid min-w-[40rem] grid-cols-[minmax(13rem,1.7fr)_minmax(13rem,1fr)] items-center gap-3 border-b border-slate-800 bg-neutral-950/95 px-3 py-2 font-mono text-[0.76rem] uppercase leading-none text-slate-500"
        role="row"
      >
        <div>Conversation</div>
        <div className="justify-self-end">Stats</div>
      </div>
      {props.conversations.map((conversation) => (
        <ConversationTableRow
          conversation={conversation}
          key={conversation.id}
          search={props.search}
          selected={props.selectedId === conversation.id}
        />
      ))}
    </div>
  );
}

/** Render the compact latest-conversation stack on the command center. */
export function ConversationStack(props: { conversations: Conversation[] }) {
  if (props.conversations.length === 0) {
    return <EmptyTelemetry>No conversation telemetry yet.</EmptyTelemetry>;
  }

  return (
    <div className="grid gap-2 p-3">
      {props.conversations.map((conversation) => {
        return (
          <ConversationStackRow
            conversation={conversation}
            key={conversation.id}
          />
        );
      })}
    </div>
  );
}

function EmptyTelemetry(props: { children: ReactNode }) {
  return (
    <div className="relative min-w-0 border border-slate-800 bg-neutral-950/70 px-4 py-3 pl-5 font-mono text-[0.88rem] leading-relaxed text-slate-400">
      <span className="absolute bottom-0 left-0 top-0 w-1 bg-amber-400" />
      {props.children}
    </div>
  );
}

function ConversationTableRow(props: {
  conversation: Conversation;
  search?: string;
  selected?: boolean;
}) {
  const visualStatus = visualStatusForConversation(props.conversation);
  const navigate = useNavigate();
  const href = {
    pathname: conversationPath(props.conversation.id),
    search: props.search ?? "",
  };
  const openConversation = () => navigate(href);
  return (
    <div
      className={conversationRecordClass(visualStatus, props.selected)}
      onClick={openConversation}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openConversation();
        }
      }}
      role="link"
      tabIndex={0}
    >
      <ConversationSummary conversation={props.conversation} />
      <ConversationRowStats
        conversation={props.conversation}
        timeLabel={formatTime(props.conversation.lastSeenAt)}
      />
    </div>
  );
}

function ConversationStackRow(props: { conversation: Conversation }) {
  const visualStatus = visualStatusForConversation(props.conversation);
  const navigate = useNavigate();
  const href = conversationPath(props.conversation.id);
  return (
    <div
      className={conversationStackRowClass(visualStatus)}
      onClick={() => navigate(href)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(href);
        }
      }}
      role="link"
      tabIndex={0}
    >
      <ConversationSummary conversation={props.conversation} />
      <ConversationRowStats
        conversation={props.conversation}
        timeLabel={formatRelativeTime(props.conversation.lastSeenAt)}
      />
    </div>
  );
}

function ConversationSummary(props: { conversation: Conversation }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[1.04rem] font-bold leading-tight text-slate-100 group-hover:text-white">
        {conversationDisplayTitle(props.conversation)}
      </div>
      <div className="mt-1 truncate font-mono text-[0.82rem] leading-relaxed text-slate-400">
        {conversationIdentityMeta(props.conversation, props.conversation.id)}
        {props.conversation.sentryConversationUrl ? (
          <>
            {" · "}
            <a
              className="border-b border-cyan-400/40 font-mono text-[0.82rem] leading-relaxed text-cyan-300 no-underline hover:border-cyan-300"
              href={props.conversation.sentryConversationUrl}
              onClick={(event) => event.stopPropagation()}
              rel="noreferrer"
              target="_blank"
            >
              View in Sentry
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

function bucketLabel(timestampMs: number, timeZone: string): string {
  return new Date(timestampMs).toLocaleDateString(undefined, {
    timeZone,
    weekday: "short",
  });
}

function ConversationRowStats(props: {
  conversation: Conversation;
  timeLabel: string;
}) {
  return (
    <div className="grid min-w-0 justify-items-end gap-1 text-right">
      <div className="font-mono text-[0.82rem] leading-relaxed text-slate-400">
        {props.conversation.turns.length} turns · {props.timeLabel}
      </div>
      {props.conversation.channel ? (
        <div className="max-w-full truncate font-mono text-[0.82rem] leading-relaxed text-slate-400">
          {slackLocationLabel(props.conversation, { includeId: false })}
        </div>
      ) : null}
    </div>
  );
}

function statusBorderClass(status: VisualStatus): string {
  if (status === "active") return "border-l-emerald-400";
  if (status === "hung") return "border-l-amber-400";
  if (status === "failed") return "border-l-rose-400";
  return "border-l-slate-500";
}

function conversationRecordClass(
  status: VisualStatus,
  selected: boolean | undefined,
): string {
  return cn(
    "group grid min-w-[40rem] cursor-pointer grid-cols-[minmax(13rem,1.7fr)_minmax(13rem,1fr)] items-center gap-3 overflow-hidden border-b border-l-4 border-b-slate-800 bg-neutral-950/50 px-3 py-3 text-left text-inherit no-underline transition-colors hover:bg-neutral-900",
    statusBorderClass(status),
    status === "idle" && "saturate-50",
    selected && "border-l-cyan-400 bg-neutral-900",
  );
}

function conversationStackRowClass(status: VisualStatus): string {
  return cn(
    "group relative grid min-h-16 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(12rem,max-content)] items-center gap-3 overflow-hidden border-y border-r border-l-4 border-y-slate-800 border-r-slate-800 bg-neutral-950/70 px-4 py-3 text-inherit no-underline transition-colors hover:border-y-slate-600 hover:border-r-slate-600 hover:bg-neutral-900 max-md:grid-cols-1",
    statusBorderClass(status),
    status === "idle" && "saturate-50",
  );
}
