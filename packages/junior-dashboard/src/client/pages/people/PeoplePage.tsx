import { Duration } from "../../components/Duration";
import { useDeferredValue, useState } from "react";
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
import { getDashboardAgentName } from "../../agentName";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber } from "../../format";
import {
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { SystemPageLayout } from "../system/SystemPageLayout";
import { PeopleActivityChart } from "./PeopleActivityChart";
import {
  filterPeople,
  PeopleDirectory,
  type PeopleSort,
} from "./PeopleDirectory";

const PEOPLE_SORTS = [
  "activeDays",
  "conversations",
  "recent",
  "runtime",
] as const satisfies readonly PeopleSort[];

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
  const [peopleSearch, setPeopleSearch, peopleQuery] =
    useDebouncedSearchParam();
  const [range, setRange] = useState<TimeRangeDays>(90);
  const [sort, setSort] = useSearchParamEnum(
    "sort",
    "conversations",
    PEOPLE_SORTS,
  );
  const deferredSort = useDeferredValue(sort);
  if (!props.data && !props.error) {
    return <LoadingView label="Loading people" />;
  }

  const data = props.data;
  const visibleActivity = data?.activityDays.slice(-range) ?? [];
  const people = data
    ? filterPeople(data.people, peopleQuery, deferredSort)
    : [];
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
    <SystemPageLayout>
      <PageHeader
        actions={<TimeRangeSelector onChange={setRange} value={range} />}
        description={
          props.error
            ? "People failed to load."
            : `See who's been working with ${getDashboardAgentName()}, how often, and for how long.`
        }
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
              value={<Duration value={runtimeMs} />}
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
            loading={sort !== deferredSort}
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
    </SystemPageLayout>
  );
}
