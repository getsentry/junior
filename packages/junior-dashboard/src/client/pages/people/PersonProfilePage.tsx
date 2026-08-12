import { useState } from "react";
import { Duration, formatDuration } from "../../components/Duration";
import { ArrowLeft, Clock3, Coins, MessageSquare } from "lucide-react";
import { Link, useParams } from "react-router";
import type {
  ActorProfileReport,
  ConversationStatsItem,
} from "@sentry/junior/api/schema";

import { useActorProfileData } from "../../api";
import { ContributionGrid } from "./ContributionGrid";
import { SystemMetricCharts } from "../../components/charts/SystemMetricCharts";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionHeader } from "../../components/layout/SectionHeader";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber } from "../../format";

function runtimeLabel(durationMs: number, conversations: number): string {
  if (durationMs <= 0 && conversations > 0) return "unknown";
  return formatDuration(durationMs);
}

/** Render one actor's profile and activity summary. */
export function PersonProfilePage() {
  const params = useParams();
  const email = params.email ? decodeURIComponent(params.email) : undefined;
  const query = useActorProfileData(email);
  if (!query.data && !query.error) {
    return <LoadingView label="Loading profile" />;
  }
  return (
    <PageLayout>
      {query.data ? (
        <Profile profile={query.data} />
      ) : (
        <Card padding="md">
          <EmptyTelemetry>Profile failed to load.</EmptyTelemetry>
        </Card>
      )}
    </PageLayout>
  );
}

/** Present one actor's activity and dimensions. */
export function Profile(props: { profile: ActorProfileReport }) {
  const [range, setRange] = useState<TimeRangeDays>(30);
  const profile = props.profile;
  const displayName =
    profile.actor.fullName ??
    profile.actor.slackUserName ??
    profile.actor.email;

  return (
    <div className="grid min-w-0 gap-5">
      <Link
        className="flex w-fit items-center gap-2 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
        to="/system/people"
      >
        <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
        Back to people
      </Link>
      <PageHeader
        description={
          <>
            {profile.actor.email}
            {profile.actor.slackUserName
              ? ` / @${profile.actor.slackUserName}`
              : ""}
          </>
        }
        onRangeChange={setRange}
        range={range}
        title={displayName}
      />

      <section className="grid gap-4" aria-labelledby="profile-metrics-title">
        <SectionIntro
          id="profile-metrics-title"
          title="Usage over time"
        />
        <SystemMetricCharts days={profile.activityDays.slice(-range)} />
      </section>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <aside className="grid min-w-0 gap-4 lg:order-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <StatCard
              detail="Across the complete conversation index"
              icon={MessageSquare}
              label="Conversations"
              value={formatCompactNumber(profile.totals.conversations)}
            />
            <StatCard
              detail="Cumulative persisted conversation runtime"
              icon={Clock3}
              label="Runtime"
              value={<Duration value={profile.totals.durationMs} />}
            />
            <StatCard
              detail="Persisted model token usage"
              icon={Coins}
              label="Tokens"
              value={formatCompactNumber(profile.totals.tokens ?? 0)}
            />
          </div>
        </aside>

        <div className="grid min-w-0 gap-5 lg:order-1">
          <Card as="section" className="mb-0" variant="section">
            <SectionHeader
              actions={
                <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                  52 weeks
                </div>
              }
            >
              <SectionTitle>Activity</SectionTitle>
            </SectionHeader>
            <ContributionGrid days={profile.activityDays} />
          </Card>
          <div className="grid min-w-0 gap-5 md:grid-cols-2">
            <LeaderboardSection items={profile.locations} title="Places" />
            <LeaderboardSection items={profile.surfaces} title="Surfaces" />
          </div>
        </div>
      </div>
    </div>
  );
}

function LeaderboardSection(props: {
  items: ConversationStatsItem[];
  title: string;
}) {
  if (props.items.length <= 1) return null;
  return (
    <Card as="section" className="mb-0" variant="section">
      <SectionHeader>
        <SectionTitle>{props.title}</SectionTitle>
      </SectionHeader>
      <ol className="m-0 list-none p-0">
        {props.items.slice(0, 6).map((item, index) => (
          <li
            className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-dashboard-border-subtle px-4 py-3 last:border-b-0"
            key={item.label}
          >
            <div className="font-mono text-xs leading-none text-dashboard-text-muted">
              {index + 1}
            </div>
            <div className="min-w-0">
              <div className="truncate font-display text-base font-medium leading-tight text-dashboard-text">
                {item.label}
              </div>
              <div className="mt-1 truncate font-mono text-xs leading-tight text-dashboard-text-muted">
                {runtimeLabel(item.durationMs, item.conversations)}
                {item.tokens
                  ? ` / ${formatCompactNumber(item.tokens)} tokens`
                  : ""}
                {item.failed
                  ? ` / ${formatCompactNumber(item.failed)} errors`
                  : ""}
              </div>
            </div>
            <div className="font-display text-xl font-light leading-none text-dashboard-text">
              {formatCompactNumber(item.conversations)}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
