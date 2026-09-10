import { formatDuration } from "../../components/Duration";
import { UserRound } from "lucide-react";
import type {
  ActorSummaryReport,
  ActorWindowMetrics,
} from "@sentry/junior/api/schema";

import { SearchInput } from "../../components/SearchInput";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
import {
  DirectoryIdentity,
  DirectoryRow,
  DirectoryTable,
  DirectoryToolbar,
} from "../../components/directory/DirectoryTable";
import { DirectoryMetric } from "../../components/directory/DirectoryMetric";
import { Card } from "../../components/layout/Card";
import { CardHeader } from "../../components/layout/CardHeader";
import { cn } from "../../styles";
import { formatCompactNumber, formatCostSummary, peoplePath } from "../../format";

export type PeopleSort =
  | "conversations"
  | "recent"
  | "runtime"
  | "spend"
  | "spendDelta";

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

function personWindow(
  person: ActorSummaryReport,
  range: TimeRangeDays,
): ActorWindowMetrics {
  return person.windows[range];
}

function spendDelta(window: ActorWindowMetrics): number {
  return window.costUsd - window.priorCostUsd;
}

/** Format signed spend change for directory rows. */
export function formatSpendDelta(deltaUsd: number): string {
  if (Math.abs(deltaUsd) < 0.005) return "$0.00";
  const absolute = formatCostSummary({ total: Math.abs(deltaUsd) });
  return `${deltaUsd > 0 ? "+" : "−"}${absolute}`;
}

/** Filter and order people without mutating the reporting response. */
export function filterPeople(
  people: ActorSummaryReport[],
  query: string,
  sort: PeopleSort,
  range: TimeRangeDays,
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
    const leftWindow = personWindow(left, range);
    const rightWindow = personWindow(right, range);
    if (sort === "spend") {
      return (
        rightWindow.costUsd - leftWindow.costUsd ||
        spendDelta(rightWindow) - spendDelta(leftWindow) ||
        left.actor.email.localeCompare(right.actor.email)
      );
    }
    if (sort === "spendDelta") {
      return (
        spendDelta(rightWindow) - spendDelta(leftWindow) ||
        rightWindow.costUsd - leftWindow.costUsd ||
        left.actor.email.localeCompare(right.actor.email)
      );
    }
    if (sort === "conversations") {
      return (
        rightWindow.conversations - leftWindow.conversations ||
        rightWindow.costUsd - leftWindow.costUsd
      );
    }
    if (sort === "runtime") {
      return (
        rightWindow.durationMs - leftWindow.durationMs ||
        rightWindow.costUsd - leftWindow.costUsd
      );
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
  range: TimeRangeDays;
  sort: PeopleSort;
  totalPeople: number;
}) {
  return (
    <Card>
      <CardHeader
        description={`${props.people.length} of ${props.totalPeople} people`}
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
            { label: "Most spend", value: "spend" },
            { label: "Biggest spend increase", value: "spendDelta" },
            { label: "Most conversations", value: "conversations" },
            { label: "Recently active", value: "recent" },
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
        headers={["Person", "Conversations", "Spend", "Runtime"]}
        loading={props.loading}
      >
        {props.people.map((person) => {
          const window = personWindow(person, props.range);
          const delta = spendDelta(window);
          return (
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
                value={formatCompactNumber(window.conversations)}
              />
              <DirectoryMetric
                label="Spend"
                value={
                  <span className="inline-flex flex-col items-end gap-1">
                    <span className="whitespace-nowrap">
                      {formatCostSummary({ total: window.costUsd }) || "$0.00"}
                    </span>
                    <span
                      className={cn(
                        "whitespace-nowrap font-mono text-2xs leading-none",
                        Math.abs(delta) < 0.005
                          ? "text-dashboard-text-muted"
                          : delta > 0
                            ? "text-amber-300/80"
                            : "text-cyan-300/75",
                      )}
                    >
                      {formatSpendDelta(delta)}
                    </span>
                  </span>
                }
              />
              <DirectoryMetric
                label="Runtime"
                value={
                  <span className="whitespace-nowrap">
                    {runtimeLabel(window.durationMs, window.conversations)}
                  </span>
                }
              />
            </DirectoryRow>
          );
        })}
      </DirectoryTable>
    </Card>
  );
}
