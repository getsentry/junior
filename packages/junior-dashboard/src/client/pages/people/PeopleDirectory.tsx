import { formatDuration } from "../../components/Duration";
import { Link } from "react-router";
import { UserRound } from "lucide-react";
import type { ActorSummaryReport } from "@sentry/junior/api/schema";

import { ConversationSearchInput } from "../../components/ConversationListControls";
import { DirectoryRowsSkeleton } from "../../components/DirectoryRowsSkeleton";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";
import { Card } from "../../components/layout/Card";
import { DirectoryMetric } from "../../components/metrics/DirectoryMetric";
import { formatCompactNumber, peoplePath } from "../../format";

export type PeopleSort = "activeDays" | "conversations" | "recent" | "runtime";

function actorName(person: Pick<ActorSummaryReport, "actor">): string {
  return (
    person.actor.fullName ?? person.actor.slackUserName ?? person.actor.email
  );
}

function personMeta(person: ActorSummaryReport): string | undefined {
  return actorName(person) === person.actor.email
    ? undefined
    : person.actor.email;
}

function runtimeLabel(durationMs: number, conversations: number): string {
  if (durationMs <= 0 && conversations > 0) return "unknown";
  return formatDuration(durationMs);
}

/** Filter and order people without mutating the reporting response. */
export function filterPeople(
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
          person.actor.slackUserName,
        ].some((value) => value?.toLowerCase().includes(normalized)),
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

/** Render the searchable people table inside the shared analytics card. */
export function PeopleDirectory(props: {
  onQueryChange(value: string): void;
  onSortChange(value: PeopleSort): void;
  loading?: boolean;
  people: ActorSummaryReport[];
  query: string;
  sort: PeopleSort;
  totalPeople: number;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <div>
          <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
            People directory
          </h3>
          <p className="mt-1 mb-0 font-mono text-[0.68rem] text-white/30">
            {props.people.length} of {props.totalPeople} verified actors
          </p>
        </div>
      </div>
      <div className="grid gap-2 border-b border-white/[0.06] bg-black/15 px-3 py-3 md:grid-cols-[minmax(14rem,1fr)_minmax(10rem,14rem)]">
        <ConversationSearchInput
          label="Search people"
          placeholder="Search name, email, Slack handle..."
          value={props.query}
          onChange={props.onQueryChange}
        />
        <DirectorySortSelect
          ariaLabel="Sort people"
          onChange={(value) => props.onSortChange(value as PeopleSort)}
          options={[
            { label: "Most conversations", value: "conversations" },
            { label: "Recently active", value: "recent" },
            { label: "Most active days", value: "activeDays" },
            { label: "Most runtime", value: "runtime" },
          ]}
          value={props.sort}
        />
      </div>
      {props.loading ? (
        <DirectoryRowsSkeleton />
      ) : props.people.length === 0 ? (
        <div className="p-4">
          <EmptyTelemetry>No people match this search.</EmptyTelemetry>
        </div>
      ) : (
        <div className="min-w-0" role="table">
          <div
            className="grid grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-4 border-b border-white/[0.06] bg-black/20 px-4 py-2.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-white/30 max-md:hidden"
            role="row"
          >
            <div>Person</div>
            <div className="justify-self-end">Conversations</div>
            <div className="justify-self-end">Active days</div>
            <div className="justify-self-end">Runtime</div>
          </div>
          {props.people.map((person) => (
            <Link
              className="group grid min-w-0 grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-4 border-b border-white/[0.055] px-4 py-3.5 text-inherit no-underline transition-colors last:border-b-0 hover:bg-white/[0.035] max-md:grid-cols-3 max-md:gap-x-3 max-md:gap-y-4"
              key={person.actor.email}
              to={peoplePath(person.actor.email)}
            >
              <div className="flex min-w-0 items-center gap-3 max-md:col-span-3">
                <span className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-amber-500/[0.07] text-amber-300 transition-colors group-hover:border-amber-500/25">
                  <UserRound aria-hidden="true" size={16} strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-display text-[1rem] font-medium leading-tight text-white/90">
                    {actorName(person)}
                  </div>
                  {personMeta(person) ? (
                    <div className="mt-1 truncate font-mono text-[0.68rem] leading-tight text-white/35">
                      {personMeta(person)}
                    </div>
                  ) : null}
                </div>
              </div>
              <DirectoryMetric
                label="Conversations"
                value={formatCompactNumber(person.conversations)}
              />
              <DirectoryMetric
                label="Active days"
                value={formatCompactNumber(person.activeDays)}
              />
              <DirectoryMetric
                label="Runtime"
                value={runtimeLabel(person.durationMs, person.conversations)}
              />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
