import { Duration } from "../../components/Duration";
import { Clock3, Coins, MapPin, MessageSquare, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import type { LocationDetailReport } from "@sentry/junior/api/schema";

import { useLocationDetailData } from "../../api";
import { Button } from "../../components/Button";
import { ConversationList } from "../../components/ConversationList";
import { ConversationSearchInput } from "../../components/ConversationListControls";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Section } from "../../components/Section";
import { SectionHeader } from "../../components/SectionHeader";
import { SectionTitle } from "../../components/SectionTitle";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import {
  buildConversations,
  filterConversationList,
  formatCompactNumber,
  formatRelativeTime,
  formatTime,
  peoplePath,
} from "../../format";
import { cn, dashboardContainerClass } from "../../styles";
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
    return <LoadingView label="Loading location" />;
  }
  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
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
    </div>
  );
}

function LocationDetail(props: { detail: LocationDetailReport }) {
  const detail = props.detail;
  const [search, setSearch] = useState("");
  const conversations = buildConversations(detail.recentConversations);
  const visible = filterConversationList(conversations, { query: search });
  return (
    <>
      <PageHeader
        description={`${detail.provider} public ${detail.kind} / ${detail.providerDestinationId} / last active ${formatRelativeTime(detail.lastSeenAt)}`}
        eyebrow="Locations / public channel"
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
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-4">
          <span className="grid size-9 place-items-center rounded border border-cyan-400/15 bg-cyan-400/[0.06] text-cyan-300">
            <MapPin aria-hidden="true" size={16} />
          </span>
          <div>
            <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
              People seen here
            </h3>
            <p className="mt-1 mb-0 font-mono text-[0.68rem] text-white/30">
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
                  <div className="truncate font-display text-[0.95rem] font-medium text-white/85">
                    {item.label}
                  </div>
                  <div className="mt-1 font-mono text-[0.66rem] text-white/30">
                    {formatCompactNumber(item.conversations)} conversations /{" "}
                    <Duration value={item.durationMs} />
                  </div>
                </>
              );
              const className =
                "min-w-0 border-b border-r border-white/[0.055] px-4 py-3.5 transition-colors hover:bg-white/[0.03]";
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

      <Section className="mb-0">
        <SectionHeader>
          <div>
            <SectionTitle>Recent conversations</SectionTitle>
            <div className="mt-1 font-mono text-[0.67rem] text-white/30">
              {visible.length} of {conversations.length} / generated{" "}
              {formatTime(detail.generatedAt)}
            </div>
          </div>
        </SectionHeader>
        <div className="grid gap-2 border-b border-white/[0.06] bg-black/15 p-3 md:grid-cols-[minmax(12rem,36rem)_auto]">
          <ConversationSearchInput
            label="Search location conversations"
            placeholder="Search title, person, or ID..."
            value={search}
            onChange={setSearch}
          />
          {search ? (
            <Button
              className="h-9 justify-center"
              onClick={() => setSearch("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <ConversationList
          conversations={visible}
          emptyLabel="No conversations match this search."
        />
      </Section>
    </>
  );
}
