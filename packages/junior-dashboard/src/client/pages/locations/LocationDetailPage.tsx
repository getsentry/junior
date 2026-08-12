import { Duration } from "../../components/Duration";
import { Clock3, Coins, MapPin, MessageSquare, Users } from "lucide-react";
import { Link, useParams } from "react-router";
import type { LocationDetailReport } from "@sentry/junior/api/schema";

import { useLocationDetailData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import {
  formatCompactNumber,
  formatRelativeTime,
  peoplePath,
} from "../../format";
import { SystemPageLayout } from "../system/SystemPageLayout";
import { LocationActivityChart } from "./LocationActivityChart";

/** Render operational activity for one persisted public location. */
export function LocationDetailPage() {
  const params = useParams();
  const query = useLocationDetailData(params.locationId);
  return <LocationDetailPageContent data={query.data} error={query.error} />;
}

/** Render loaded, stale, failed, and loading public-location detail states. */
export function LocationDetailPageContent(props: {
  data: LocationDetailReport | undefined;
  error: unknown;
}) {
  if (!props.data && !props.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading location" />
      </SystemPageLayout>
    );
  }
  return (
    <SystemPageLayout>
      {props.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            {props.data
              ? "Location telemetry refresh failed. Showing cached data."
              : "Location failed to load."}
          </EmptyTelemetry>
        </Card>
      ) : null}
      {props.data ? <LocationDetail detail={props.data} /> : null}
    </SystemPageLayout>
  );
}

function LocationDetail(props: { detail: LocationDetailReport }) {
  const detail = props.detail;
  return (
    <>
      <PageHeader
        description={`${detail.provider} public ${detail.kind} / ${detail.providerDestinationId} / last active ${formatRelativeTime(detail.lastSeenAt)}`}
        title={detail.label}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail="Persisted conversations"
          icon={MessageSquare}
          label="Conversations"
          value={formatCompactNumber(detail.conversations)}
        />
        <StatCard
          detail="Verified people seen here"
          icon={Users}
          label="People"
          value={formatCompactNumber(detail.actors.length)}
        />
        <StatCard
          detail="Persisted model usage"
          icon={Coins}
          label="Tokens"
          value={formatCompactNumber(detail.tokens ?? 0)}
        />
        <StatCard
          detail="Cumulative conversation runtime"
          icon={Clock3}
          label="Runtime"
          value={<Duration value={detail.durationMs} />}
        />
      </div>

      <LocationActivityChart days={detail.activityDays} />

      <Card>
        <div className="flex items-center gap-3 border-b border-dashboard-border-subtle px-4 py-4">
          <span className="grid size-9 place-items-center rounded border border-cyan-400/15 bg-cyan-400/[0.06] text-cyan-300">
            <MapPin aria-hidden="true" size={16} />
          </span>
          <div>
            <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
              People seen here
            </h3>
            <p className="mt-1 mb-0 font-mono text-xs text-dashboard-text-muted">
              Verified contributors across persisted conversations.
            </p>
          </div>
        </div>
        {detail.actors.length ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3">
            {detail.actors.slice(0, 9).map((item, index) => {
              const key = [
                item.actor.email,
                item.actor.slackUserId,
                item.actor.slackUserName,
                item.actor.fullName,
                index,
              ].join(":");
              const content = (
                <>
                  <div className="truncate font-display text-base font-medium text-dashboard-text">
                    {item.label}
                  </div>
                  <div className="mt-1 font-mono text-xs text-dashboard-text-muted">
                    {formatCompactNumber(item.conversations)} conversations /{" "}
                    <Duration value={item.durationMs} />
                  </div>
                </>
              );
              const className =
                "min-w-0 border-b border-r border-dashboard-border-subtle px-4 py-3.5 transition-colors hover:bg-dashboard-fill-soft";
              return item.actor.email ? (
                <Link
                  className={`${className} text-inherit no-underline`}
                  key={key}
                  to={peoplePath(item.actor.email)}
                >
                  {content}
                </Link>
              ) : (
                <div className={className} key={key}>
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-4">
            <EmptyTelemetry>
              No verified people have been recorded here.
            </EmptyTelemetry>
          </div>
        )}
      </Card>
    </>
  );
}
