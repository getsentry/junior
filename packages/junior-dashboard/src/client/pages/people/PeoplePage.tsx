import { useState } from "react";
import { Activity, Clock3, MessageSquare, Users } from "lucide-react";
import type { ActorDirectoryReport } from "@sentry/junior/api/schema";

import { useActorDirectoryData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatMs } from "../../format";
import { cn, dashboardContainerClass } from "../../styles";
import { PeopleActivityChart } from "./PeopleActivityChart";
import {
  filterPeople,
  PeopleDirectory,
  type PeopleSort,
} from "./PeopleDirectory";

/** Render the actor directory returned by the REST API. */
export function PeoplePage() {
  const query = useActorDirectoryData();
  return <PeoplePageContent data={query.data} error={query.error} />;
}

/** Render People analytics, failure states, and the actor directory. */
export function PeoplePageContent(props: {
  data: ActorDirectoryReport | undefined;
  error: unknown;
}) {
  const [peopleSearch, setPeopleSearch] = useState("");
  const [range, setRange] = useState<TimeRangeDays>(30);
  const [sort, setSort] = useState<PeopleSort>("recent");
  if (!props.data && !props.error) {
    return <LoadingView label="Loading people" />;
  }

  const data = props.data;
  const visibleActivity = data?.activityDays.slice(-range) ?? [];
  const people = data ? filterPeople(data.people, peopleSearch, sort) : [];
  const indexedConversations =
    data?.people.reduce((total, person) => total + person.conversations, 0) ??
    0;
  const runtimeMs =
    data?.people.reduce((total, person) => total + person.durationMs, 0) ?? 0;
  const firstDate = visibleActivity[0]?.date;
  const activePeople = firstDate
    ? (data?.people.filter(
        (person) => person.lastSeenAt.slice(0, 10) >= firstDate,
      ).length ?? 0)
    : 0;
  const peak = Math.max(0, ...visibleActivity.map((day) => day.activePeople));

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        actions={<TimeRangeSelector onChange={setRange} value={range} />}
        description={
          props.error
            ? "People failed to load."
            : "See who's been working with Junior, how often, and for how long."
        }
        eyebrow="Who's been around"
        title="People"
      />
      {props.error ? (
        <Card padding="md">
          <EmptyTelemetry>
            People telemetry is unavailable. Try refreshing the dashboard.
          </EmptyTelemetry>
        </Card>
      ) : data?.people.length ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              detail={`Verified actors seen in the last ${range} days`}
              icon={Users}
              label="Active people"
              value={formatCompactNumber(activePeople)}
            />
            <StatCard
              detail="Across the complete conversation index"
              icon={MessageSquare}
              label="Conversations"
              value={formatCompactNumber(indexedConversations)}
            />
            <StatCard
              detail="Cumulative persisted conversation runtime"
              icon={Clock3}
              label="Total runtime"
              value={formatMs(runtimeMs)}
            />
            <StatCard
              detail={`Highest distinct daily count in ${range} days`}
              icon={Activity}
              label="Peak daily active"
              value={formatCompactNumber(peak)}
            />
          </div>
          <PeopleActivityChart days={visibleActivity} />
          <PeopleDirectory
            onQueryChange={setPeopleSearch}
            onSortChange={setSort}
            people={people}
            query={peopleSearch}
            sort={sort}
            totalPeople={data.people.length}
          />
        </>
      ) : (
        <Card padding="md">
          <EmptyTelemetry>
            No actor telemetry with trusted email.
          </EmptyTelemetry>
        </Card>
      )}
    </div>
  );
}
