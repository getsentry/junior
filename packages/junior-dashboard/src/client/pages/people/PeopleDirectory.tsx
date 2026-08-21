import { formatDuration } from "../../components/Duration";
import { UserRound } from "lucide-react";
import type { ActorSummaryReport } from "@sentry/junior/api/schema";

import { SearchInput } from "../../components/SearchInput";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";
import {
  DirectoryIdentity,
  DirectoryRow,
  DirectoryTable,
  DirectoryToolbar,
} from "../../components/directory/DirectoryTable";
import { DirectoryMetric } from "../../components/directory/DirectoryMetric";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
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
      <CardHeader
        description={`${props.people.length} of ${props.totalPeople} verified actors`}
        title="People directory"
      />
      <DirectoryToolbar columnsClassName="md:grid-cols-[minmax(14rem,1fr)_minmax(10rem,14rem)]">
        <SearchInput
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
      </DirectoryToolbar>
      <DirectoryTable
        ariaLabel="People directory results"
        empty={
          props.people.length === 0 ? (
            <EmptyTelemetry>No people match this search.</EmptyTelemetry>
          ) : undefined
        }
        headers={["Person", "Conversations", "Active days", "Runtime"]}
        loading={props.loading}
      >
        {props.people.map((person) => (
          <DirectoryRow
            key={person.actor.email}
            to={peoplePath(person.actor.email)}
          >
            <DirectoryIdentity
              description={personMeta(person)}
              icon={
                <UserRound aria-hidden="true" size={16} strokeWidth={1.8} />
              }
              iconClassName="bg-amber-500/[0.07] text-amber-300 group-hover:border-amber-500/25"
              title={actorName(person)}
            />
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
              value={
                <>
                  <span className="whitespace-nowrap md:hidden">
                    {runtimeLabel(person.durationMs, person.conversations)}
                  </span>
                  <span className="hidden whitespace-nowrap md:inline">
                    {runtimeLabel(person.durationMs, person.conversations)}
                  </span>
                </>
              }
            />
          </DirectoryRow>
        ))}
      </DirectoryTable>
    </Card>
  );
}
