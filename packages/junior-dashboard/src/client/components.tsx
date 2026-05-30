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
import type {
  Conversation,
  DashboardData,
  Session,
  SessionFilter,
  VisualStatus,
} from "./types";

/** Render the full-page loading treatment before the first dashboard payload lands. */
export function LoadingView(props: { label: string }) {
  return (
    <div className="loading-layout">
      <section className="loading-panel">
        <div className="loading-mark">Jr</div>
        <div>
          <div className="loading-title">{props.label}</div>
          <div className="loading-bar" />
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
      className={`activity-indicator ${activity} ${props.variant ?? "compact"}`}
      aria-label={activity}
    >
      <span className="activity-box" />
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
    <aside className="rail">
      <section className="section">
        <div className="section-header">
          <div>
            <div className="kicker">Command Center</div>
            <div className="section-title">Pulse</div>
          </div>
          <div className="live">
            {props.error ? "degraded" : props.data ? "online" : "checking"}
          </div>
        </div>
        <div className="meter">
          <div className="status-word">
            {props.error
              ? "ERR"
              : (props.data?.health.status.toUpperCase() ?? "...")}
          </div>
          <div className="status-caption">
            {props.error
              ? props.error.message
              : props.data
                ? `${props.data.health.service} / ${formatTime(props.data.health.timestamp)}`
                : "Waiting for Junior telemetry."}
          </div>
        </div>
        <div className="stats">
          <Stat label="plugins" value={props.data?.plugins.length ?? 0} />
          <Stat label="skills" value={props.data?.skills.length ?? 0} />
          <Stat label="active" value={activeSessions.length} />
          <Stat label="hung" value={hungSessions.length} />
          <Stat label="failed" value={failedSessions.length} />
        </div>
      </section>
    </aside>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{props.value}</div>
      <div className="stat-label">{props.label}</div>
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
    <section className="section">
      <div className="section-header">
        <div>
          <div className="kicker">7 Day Duration</div>
          <div className="section-title">Turns</div>
        </div>
        <div className="chart-legend">
          <span className="legend-complete">Complete</span>
          <span className="legend-hung">Hung</span>
          <span className="legend-error">Error</span>
        </div>
      </div>
      <div
        className="turn-chart"
        aria-label="Turn duration over the last 7 days"
      >
        <ResponsiveContainer height={190} width="100%">
          <LineChart
            data={points}
            margin={{ bottom: 0, left: 0, right: 4, top: 14 }}
          >
            <CartesianGrid stroke="rgba(64, 81, 107, 0.18)" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="x"
              domain={[rangeStartMs, rangeEndMs]}
              tickFormatter={(value) =>
                bucketLabel(Number(value), props.timeZone)
              }
              tick={{
                fill: "var(--dim)",
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
                fill: "var(--dim)",
                fontFamily: "ui-monospace",
                fontSize: 11,
              }}
              tickLine={false}
              type="number"
            />
            <Tooltip
              content={<TurnDurationTooltip />}
              cursor={{ stroke: "rgba(64, 81, 107, 0.34)" }}
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
      <div className="chart-summary">
        {totals.total} turns · {totals.hung} hung · {totals.failed} errors
      </div>
    </section>
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
        className="turn-chart-dot"
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
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{point.tooltipLabel}</div>
      <div className="chart-tooltip-primary">{formatMs(point.durationMs)}</div>
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
    <div className="filters">
      {filters.map((filter) => (
        <button
          className={`filter ${props.current === filter ? "active" : ""}`}
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
      <div className="sessions">
        <div className="session-row empty">
          No matching conversation telemetry.
        </div>
      </div>
    );
  }

  return (
    <div className="session-table" role="table">
      <div className="session-head conversation-head" role="row">
        <div>Conversation</div>
        <div>Stats</div>
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
    return (
      <div className="session-row empty">No conversation telemetry yet.</div>
    );
  }

  return (
    <div className="conversation-stack">
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
      className={`session-record conversation-record status-${visualStatus} ${
        props.selected ? "selected" : ""
      }`}
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
      className={`session-row session-row-link conversation-stack-row status-${visualStatus}`}
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
    <div className="session-main">
      <div className="session-title conversation-title conversation-title-link">
        {conversationDisplayTitle(props.conversation)}
      </div>
      <div className="session-meta conversation-subtext">
        {conversationIdentityMeta(props.conversation, props.conversation.id)}
        {props.conversation.sentryConversationUrl ? (
          <>
            {" · "}
            <a
              className="session-link inline-sentry-link"
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
    <div className="conversation-row-stats">
      <div className="session-time">
        {props.conversation.turns.length} turns · {props.timeLabel}
      </div>
      {props.conversation.channel ? (
        <div className="session-meta conversation-location">
          {slackLocationLabel(props.conversation, { includeId: false })}
        </div>
      ) : null}
    </div>
  );
}
