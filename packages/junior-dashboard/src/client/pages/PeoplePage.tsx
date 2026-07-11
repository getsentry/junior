import { useState } from "react";
import { Link, useParams } from "react-router";
import { Mail, UserRound } from "lucide-react";
import type { ConversationStatsItem } from "@sentry/junior/api/schema";
import type {
  ActorDirectoryReport,
  ActorSummaryReport,
  ActorTotalsReport,
} from "@sentry/junior/api/schema";
import type {
  ActorActivityDayReport,
  ActorProfileReport,
} from "@sentry/junior/api/schema";

import { useActorDirectoryData, useActorProfileData } from "../api";
import { Button } from "../components/Button";
import { ConversationList } from "../components/ConversationList";
import { ConversationSearchInput } from "../components/ConversationListControls";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { LoadingView } from "../components/LoadingView";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import {
  buildConversations,
  filterConversationList,
  formatCompactNumber,
  formatMs,
  peoplePath,
  formatRelativeTime,
  formatTime,
} from "../format";
import { cn } from "../styles";

type PeopleSort = "activeDays" | "conversations" | "recent" | "runtime";

function actorName(person: Pick<ActorSummaryReport, "actor">): string {
  return (
    person.actor.fullName ?? person.actor.slackUserName ?? person.actor.email
  );
}

function personMeta(person: ActorSummaryReport): string {
  const pieces = [
    person.actor.email,
    person.actor.slackUserName ? `@${person.actor.slackUserName}` : undefined,
    `last ${formatRelativeTime(person.lastSeenAt)}`,
  ];
  return pieces.filter(Boolean).join(" / ");
}

function sampleLabel(
  data: Pick<ActorDirectoryReport, "sampleSize" | "truncated">,
) {
  return `${formatCompactNumber(data.sampleSize)} sampled conversations${
    data.truncated ? " / limited sample" : ""
  }`;
}

function runtimeLabel(durationMs: number, conversations: number): string {
  if (durationMs <= 0 && conversations > 0) return "unknown";
  return formatMs(durationMs);
}

/** Render the actor directory returned by the REST API. */
export function PeoplePage() {
  const query = useActorDirectoryData();
  return <PeoplePageContent data={query.data} error={query.error} />;
}

/** Render loaded, failed, and empty actor directory states. */
export function PeoplePageContent({
  data,
  error,
}: {
  data: ActorDirectoryReport | undefined;
  error: unknown;
}) {
  const [peopleSearch, setPeopleSearch] = useState("");
  const [sort, setSort] = useState<PeopleSort>("recent");
  if (!data && !error) {
    return <LoadingView label="Loading people" />;
  }
  const people = data ? filterPeople(data.people, peopleSearch, sort) : [];
  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <Section>
        <SectionHeader>
          <div>
            <SectionTitle>People</SectionTitle>
            <div className="mt-1 break-words text-[0.82rem] leading-relaxed text-[#b8b8b8]">
              {data
                ? `${people.length} of ${data.people.length} actors / ${sampleLabel(data)}`
                : "People failed to load"}
            </div>
          </div>
        </SectionHeader>
        {error ? (
          <div className="p-3">
            <EmptyTelemetry>
              People telemetry is unavailable. Try refreshing the dashboard.
            </EmptyTelemetry>
          </div>
        ) : data?.people.length ? (
          <>
            <PeopleToolbar
              query={peopleSearch}
              sort={sort}
              onQueryChange={setPeopleSearch}
              onSortChange={setSort}
            />
            <PeopleDirectory people={people} />
          </>
        ) : (
          <div className="p-3">
            <EmptyTelemetry>
              No actor telemetry with trusted email.
            </EmptyTelemetry>
          </div>
        )}
      </Section>
    </div>
  );
}

function filterPeople(
  people: ActorSummaryReport[],
  query: string,
  sort: PeopleSort,
): ActorSummaryReport[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? people.filter((person) =>
        [
          person.actor.email,
          person.actor.fullName,
          person.actor.slackUserId,
          person.actor.slackUserName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalized),
      )
    : people;

  return [...filtered].sort((left, right) => {
    if (sort === "conversations") {
      return right.conversations - left.conversations;
    }
    if (sort === "activeDays") {
      return right.activeDays - left.activeDays;
    }
    if (sort === "runtime") {
      return right.durationMs - left.durationMs;
    }
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function PeopleToolbar(props: {
  query: string;
  sort: PeopleSort;
  onQueryChange(value: string): void;
  onSortChange(value: PeopleSort): void;
}) {
  return (
    <div className="grid min-w-0 gap-2 border-b border-white/10 bg-[#050505] px-3 py-3 md:grid-cols-[minmax(14rem,1fr)_minmax(10rem,14rem)]">
      <ConversationSearchInput
        label="Search people"
        placeholder="Search name, email, Slack handle..."
        value={props.query}
        onChange={props.onQueryChange}
      />
      <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-md border border-white/15 bg-[#0b0b0b] transition-colors hover:border-white/30 focus-within:border-[#beaaff]/45 focus-within:ring-1 focus-within:ring-[#beaaff]/20">
        <span className="flex h-full items-center border-r border-white/10 px-2 text-[0.68rem] font-semibold uppercase leading-none text-[#777]">
          Sort
        </span>
        <select
          aria-label="Sort people"
          className="h-full min-w-0 bg-transparent px-2 text-[0.82rem] font-semibold text-[#d6d6d6] outline-none"
          value={props.sort}
          onChange={(event) =>
            props.onSortChange(event.currentTarget.value as PeopleSort)
          }
        >
          <option value="recent">Recently active</option>
          <option value="conversations">Most conversations</option>
          <option value="activeDays">Most active days</option>
          <option value="runtime">Most runtime</option>
        </select>
      </label>
    </div>
  );
}

function PeopleDirectory(props: { people: ActorSummaryReport[] }) {
  if (props.people.length === 0) {
    return (
      <div className="p-3">
        <EmptyTelemetry>No people match this search.</EmptyTelemetry>
      </div>
    );
  }
  return (
    <div className="min-w-0" role="table">
      <div
        className="sticky top-0 z-[1] grid grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-3 border-b border-white/10 bg-[#050505] px-3 py-2 text-[0.76rem] font-semibold uppercase leading-none text-[#888] max-md:hidden"
        role="row"
      >
        <div>Actor</div>
        <div className="justify-self-end">Conversations</div>
        <div className="justify-self-end">Active days</div>
        <div className="justify-self-end">Runtime</div>
      </div>
      {props.people.map((person) => (
        <Link
          className="grid min-w-0 grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-3 border-b border-l-4 border-b-white/10 border-l-[#22a06b] bg-[#0b0b0b] px-3 py-3 text-inherit no-underline transition-colors hover:bg-[#151515] max-md:grid-cols-1 max-md:px-4 max-md:py-4"
          key={person.actor.email}
          to={peoplePath(person.actor.email)}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center border border-white/10 bg-[#101412] text-[#8bdc97]">
                <UserRound aria-hidden="true" size={16} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[1.02rem] font-bold leading-tight text-white">
                  {actorName(person)}
                </div>
                <div className="mt-1 truncate text-[0.82rem] leading-tight text-[#b8b8b8]">
                  {personMeta(person)}
                </div>
              </div>
            </div>
          </div>
          <DirectoryNumber value={person.conversations} />
          <DirectoryNumber value={person.activeDays} />
          <div className="justify-self-end text-right text-[0.92rem] font-semibold leading-tight text-white max-md:justify-self-start">
            {runtimeLabel(person.durationMs, person.conversations)}
          </div>
        </Link>
      ))}
    </div>
  );
}

function DirectoryNumber(props: { value: number }) {
  return (
    <div className="justify-self-end text-right text-xl font-extrabold leading-none text-white max-md:justify-self-start">
      {formatCompactNumber(props.value)}
    </div>
  );
}

/** Render one actor's profile and recent conversation history. */
export function PersonProfilePage() {
  const params = useParams();
  const email = params.email ? decodeURIComponent(params.email) : undefined;
  const query = useActorProfileData(email);
  if (!query.data && !query.error) {
    return <LoadingView label="Loading profile" />;
  }
  const profile = query.data;
  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      {profile ? (
        <Profile profile={profile} />
      ) : (
        <Section>
          <div className="p-3">
            <EmptyTelemetry>Profile failed to load.</EmptyTelemetry>
          </div>
        </Section>
      )}
    </div>
  );
}

export function Profile(props: { profile: ActorProfileReport }) {
  const profile = props.profile;
  const [recentSearch, setRecentSearch] = useState("");
  const conversations = buildConversations(profile.recentConversations);
  const visibleConversations = filterConversationList(conversations, {
    query: recentSearch,
  });
  return (
    <>
      <Section>
        <div className="border-b border-white/10 px-4 py-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center border border-white/10 bg-[#101412] text-[#8bdc97]">
                <Mail aria-hidden="true" size={20} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <h2 className="m-0 truncate text-2xl font-extrabold leading-tight tracking-normal text-white">
                  {profile.actor.fullName ??
                    profile.actor.slackUserName ??
                    profile.actor.email}
                </h2>
                <div className="mt-1 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
                  {profile.actor.email}
                  {profile.actor.slackUserName
                    ? ` / @${profile.actor.slackUserName}`
                    : ""}
                </div>
              </div>
            </div>
          </div>
        </div>
        <ProfileMetrics totals={profile.totals} />
      </Section>

      <Section>
        <SectionHeader
          actions={
            <div className="text-right text-[0.76rem] font-semibold uppercase leading-tight text-[#888]">
              {profile.truncated ? "limited sample" : "12 months"}
            </div>
          }
        >
          <SectionTitle>Activity</SectionTitle>
        </SectionHeader>
        <ContributionGrid days={profile.activityDays} />
      </Section>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <LeaderboardSection items={profile.locations} title="Places" />
        <LeaderboardSection items={profile.surfaces} title="Surfaces" />
      </div>

      <Section>
        <SectionHeader>
          <div>
            <SectionTitle>Recent</SectionTitle>
            <div className="mt-1 break-words text-[0.82rem] leading-relaxed text-[#b8b8b8]">
              {formatCompactNumber(visibleConversations.length)} of{" "}
              {formatCompactNumber(profile.recentConversations.length)}{" "}
              conversations / generated {formatTime(profile.generatedAt)}
            </div>
          </div>
        </SectionHeader>
        <div className="grid gap-2 border-b border-white/10 bg-[#050505] px-3 py-3 md:grid-cols-[minmax(12rem,36rem)_auto]">
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
    </>
  );
}

function ProfileMetrics(props: { totals: ActorTotalsReport }) {
  const totals = props.totals;
  const metrics = [
    ["conversations", formatCompactNumber(totals.conversations)],
    ["runtime", formatMs(totals.durationMs)],
    ["tokens", totals.tokens ? formatCompactNumber(totals.tokens) : "0"],
  ] as const;

  return (
    <div className="grid border-b border-white/10 sm:grid-cols-2 lg:grid-cols-3">
      {metrics.map(([label, value]) => (
        <div
          className="min-w-0 border-r border-t border-white/10 bg-[#050505] px-4 py-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 lg:[&:nth-child(-n+3)]:border-t-0"
          key={label}
        >
          <div className="truncate text-2xl font-extrabold leading-none text-white">
            {value}
          </div>
          <div className="mt-1 text-[0.72rem] font-semibold uppercase leading-tight text-[#888]">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

function ContributionGrid(props: { days: ActorActivityDayReport[] }) {
  const max = Math.max(1, ...props.days.map((day) => day.conversations));
  const weeks: Array<Array<ActorActivityDayReport | null>> = [];
  const leadingDays = props.days[0]
    ? new Date(`${props.days[0].date}T00:00:00Z`).getUTCDay()
    : 0;
  const cells: Array<ActorActivityDayReport | null> = [
    ...Array.from({ length: leadingDays }, () => null),
    ...props.days,
  ];
  while (cells.length > 0 && cells.length % 7 !== 0) cells.push(null);
  for (let index = 0; index < cells.length; index += 7) {
    const week: Array<ActorActivityDayReport | null> = cells.slice(
      index,
      index + 7,
    );
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  if (weeks.length === 0) {
    weeks.push([null, null, null, null, null, null, null]);
  }
  const monthLabels = weeks.map((week, index) => {
    const firstDay = week.find(Boolean);
    if (!firstDay) return "";
    const previousWeek = index > 0 ? weeks[index - 1] : undefined;
    const previousDay = previousWeek
      ? [...previousWeek].reverse().find(Boolean)
      : undefined;
    if (
      previousDay &&
      previousDay.date.slice(0, 7) === firstDay.date.slice(0, 7)
    ) {
      return "";
    }
    return new Date(`${firstDay.date}T00:00:00Z`).toLocaleString(undefined, {
      month: "short",
      timeZone: "UTC",
    });
  });

  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="w-max">
        <div
          aria-hidden="true"
          className="mb-1 grid gap-1 text-[0.64rem] font-semibold leading-none text-[#666]"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, 0.75rem)`,
          }}
        >
          {monthLabels.map((label, index) => (
            <div className="h-3 overflow-visible" key={`${label}-${index}`}>
              {label}
            </div>
          ))}
        </div>
        <div
          aria-label="Daily Junior conversation activity"
          className="grid w-max grid-flow-col grid-rows-7 gap-1"
          role="list"
          style={{
            gridTemplateColumns: `repeat(${weeks.length}, 0.75rem)`,
          }}
        >
          {weeks.flatMap((week, weekIndex) =>
            week.map((day, dayIndex) =>
              day ? (
                <span
                  aria-label={`${day.date}: ${day.conversations} conversations`}
                  className={cn(
                    "size-3 border border-black/40",
                    activityClass(day.conversations, max),
                  )}
                  key={day.date}
                  role="listitem"
                  title={`${day.date}: ${day.conversations} conversations, ${runtimeLabel(day.durationMs, day.conversations)}`}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-3 border border-black/40 bg-[#101010]"
                  key={`empty-${weekIndex}-${dayIndex}`}
                />
              ),
            ),
          )}
        </div>
        <div className="mt-3 flex items-center gap-1 text-[0.7rem] font-semibold uppercase leading-none text-[#666]">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              aria-hidden="true"
              className={cn(
                "size-3 border border-black/40",
                level === 0 && "bg-[#151515]",
                level === 1 && "bg-[#133225]",
                level === 2 && "bg-[#176a4a]",
                level === 3 && "bg-[#22a06b]",
                level === 4 && "bg-[#8bdc97]",
              )}
              key={level}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function activityClass(count: number, max: number): string {
  if (count <= 0) return "bg-[#151515]";
  const ratio = count / max;
  if (ratio >= 0.75) return "bg-[#8bdc97]";
  if (ratio >= 0.45) return "bg-[#22a06b]";
  if (ratio >= 0.2) return "bg-[#176a4a]";
  return "bg-[#133225]";
}

function LeaderboardSection(props: {
  items: ConversationStatsItem[];
  title: string;
}) {
  if (props.items.length <= 1) return null;
  return (
    <Section>
      <SectionHeader>
        <SectionTitle>{props.title}</SectionTitle>
      </SectionHeader>
      {props.items.length ? (
        <ol className="m-0 list-none p-0">
          {props.items.slice(0, 6).map((item, index) => (
            <li
              className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 px-4 py-3 last:border-b-0"
              key={item.label}
            >
              <div className="font-mono text-[0.74rem] font-semibold leading-none text-[#666]">
                {index + 1}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[0.92rem] font-semibold leading-tight text-white">
                  {item.label}
                </div>
                <div className="mt-1 truncate text-[0.76rem] leading-tight text-[#888]">
                  {runtimeLabel(item.durationMs, item.conversations)}
                  {item.tokens
                    ? ` / ${formatCompactNumber(item.tokens)} tokens`
                    : ""}
                  {item.failed
                    ? ` / ${formatCompactNumber(item.failed)} errors`
                    : ""}
                  {item.hung ? ` / ${formatCompactNumber(item.hung)} hung` : ""}
                </div>
              </div>
              <div className="text-right text-xl font-extrabold leading-none text-white">
                {formatCompactNumber(item.conversations)}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="p-3">
          <EmptyTelemetry>No telemetry.</EmptyTelemetry>
        </div>
      )}
    </Section>
  );
}
