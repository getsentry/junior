import { useState } from "react";
import { Clock3, Coins, MessageSquare } from "lucide-react";
import { useParams } from "react-router";
import type {
  ActorProfileReport,
  ConversationStatsItem,
} from "@sentry/junior/api/schema";

import { useActorProfileData } from "../../api";
import { Button } from "../../components/Button";
import { ConversationList } from "../../components/ConversationList";
import { ConversationSearchInput } from "../../components/ConversationListControls";
import { ContributionGrid } from "../../components/ContributionGrid";
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
  formatMs,
  formatTime,
} from "../../format";
import { cn, dashboardContainerClass } from "../../styles";

function runtimeLabel(durationMs: number, conversations: number): string {
  if (durationMs <= 0 && conversations > 0) return "unknown";
  return formatMs(durationMs);
}

/** Render one actor's profile and recent conversation history. */
export function PersonProfilePage() {
  const params = useParams();
  const email = params.email ? decodeURIComponent(params.email) : undefined;
  const query = useActorProfileData(email);
  if (!query.data && !query.error) {
    return <LoadingView label="Loading profile" />;
  }
  return (
    <div className={cn(dashboardContainerClass, "px-4 py-4 sm:px-8 sm:py-8")}>
      {query.data ? (
        <Profile profile={query.data} />
      ) : (
        <Card padding="md">
          <EmptyTelemetry>Profile failed to load.</EmptyTelemetry>
        </Card>
      )}
    </div>
  );
}

/** Present one actor's activity, dimensions, and recent conversations. */
export function Profile(props: { profile: ActorProfileReport }) {
  const profile = props.profile;
  const [recentSearch, setRecentSearch] = useState("");
  const conversations = buildConversations(profile.recentConversations);
  const visibleConversations = filterConversationList(conversations, {
    query: recentSearch,
  });
  const displayName =
    profile.actor.fullName ??
    profile.actor.slackUserName ??
    profile.actor.email;

  return (
    <div className="grid min-w-0 gap-5">
      <PageHeader
        description={
          <>
            {profile.actor.email}
            {profile.actor.slackUserName
              ? ` / @${profile.actor.slackUserName}`
              : ""}
          </>
        }
        eyebrow="People / profile"
        title={displayName}
      />

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
              value={formatMs(profile.totals.durationMs)}
            />
            <StatCard
              detail="Persisted model token usage"
              icon={Coins}
              label="Tokens"
              value={formatCompactNumber(profile.totals.tokens ?? 0)}
            />
          </div>
          <LeaderboardSection items={profile.locations} title="Places" />
          <LeaderboardSection items={profile.surfaces} title="Surfaces" />
        </aside>

        <div className="grid min-w-0 gap-5 lg:order-1">
          <Section className="mb-0">
            <SectionHeader
              actions={
                <div className="font-mono text-[0.66rem] uppercase tracking-[0.12em] text-white/30">
                  90 days
                </div>
              }
            >
              <SectionTitle>Activity</SectionTitle>
            </SectionHeader>
            <ContributionGrid days={profile.activityDays} />
          </Section>

          <Section className="mb-0">
            <SectionHeader>
              <div>
                <SectionTitle>Recent</SectionTitle>
                <div className="mt-1 font-mono text-[0.68rem] leading-relaxed text-white/35">
                  {formatCompactNumber(visibleConversations.length)} of{" "}
                  {formatCompactNumber(profile.recentConversations.length)}{" "}
                  conversations / generated {formatTime(profile.generatedAt)}
                </div>
              </div>
            </SectionHeader>
            <div className="grid gap-2 border-b border-white/[0.06] bg-black/15 px-3 py-3 md:grid-cols-[minmax(12rem,36rem)_auto]">
              <ConversationSearchInput
                label="Search recent conversations"
                placeholder="Search title, email, channel, id..."
                value={recentSearch}
                onChange={setRecentSearch}
              />
              {recentSearch.trim() ? (
                <Button
                  className="h-9 justify-center"
                  onClick={() => setRecentSearch("")}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <ConversationList
              conversations={visibleConversations}
              emptyLabel="No recent conversations match this search."
            />
          </Section>
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
    <Section className="mb-0">
      <SectionHeader>
        <SectionTitle>{props.title}</SectionTitle>
      </SectionHeader>
      <ol className="m-0 list-none p-0">
        {props.items.slice(0, 6).map((item, index) => (
          <li
            className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/[0.06] px-4 py-3 last:border-b-0"
            key={item.label}
          >
            <div className="font-mono text-[0.68rem] leading-none text-white/25">
              {index + 1}
            </div>
            <div className="min-w-0">
              <div className="truncate font-display text-[0.92rem] font-medium leading-tight text-white/85">
                {item.label}
              </div>
              <div className="mt-1 truncate font-mono text-[0.66rem] leading-tight text-white/30">
                {runtimeLabel(item.durationMs, item.conversations)}
                {item.tokens
                  ? ` / ${formatCompactNumber(item.tokens)} tokens`
                  : ""}
                {item.failed
                  ? ` / ${formatCompactNumber(item.failed)} errors`
                  : ""}
              </div>
            </div>
            <div className="font-display text-xl font-light leading-none text-white/90">
              {formatCompactNumber(item.conversations)}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
