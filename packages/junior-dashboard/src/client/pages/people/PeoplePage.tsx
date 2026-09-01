import { useDeferredValue, useState } from "react";
import {
  Activity,
  CircleDollarSign,
  TrendingUp,
  Users,
} from "lucide-react";
import type {
  ActorDirectoryReport,
  ActorSummaryReport,
} from "@sentry/junior/api/schema";

import { useActorDirectoryData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import {
  selectTimeSeries,
  timeRangeBucketUnit,
  timeRangeDetail,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { getDashboardAgentName } from "../../agentName";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatCostSummary } from "../../format";
import {
  useDebouncedSearchParam,
  useSearchParamEnum,
} from "../../searchParams";
import { SystemPageLayout } from "../system/SystemPageLayout";
import { PeopleActivityChart } from "./PeopleActivityChart";
import {
  filterPeople,
  formatSpendDelta,
  PeopleDirectory,
  type PeopleSort,
} from "./PeopleDirectory";

const PEOPLE_SORTS = [
  "spend",
  "spendDelta",
  "conversations",
  "recent",
  "runtime",
] as const satisfies readonly PeopleSort[];

function actorName(person: ActorSummaryReport): string {
  return (
    person.actor.fullName ?? person.actor.slackUserName ?? person.actor.email
  );
}

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
  const [range, setRange] = useState<TimeRangeDays>(7);
  const [sort, setSort] = useSearchParamEnum("sort", "spend", PEOPLE_SORTS);
  const deferredSort = useDeferredValue(sort);
  if (!props.data && !props.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading people" />
      </SystemPageLayout>
    );
  }

  const data = props.data;
  const visibleActivity = data
    ? selectTimeSeries({
        days: data.activityDays,
        hours: data.activityHours,
        sixHours: data.activitySixHours,
        range,
        emptySixHour: (date) => ({ activePeople: 0, conversations: 0, date }),
      })
    : [];
  const bucketUnit = timeRangeBucketUnit(range);
  const people = data
    ? filterPeople(data.people, peopleQuery, deferredSort, range)
    : [];
  // Count activity from the same per-range windows as spend/directory stats.
  // Chart buckets (especially 6h on 7d) can start mid-day and would drift.
  const activePeople =
    data?.people.filter((person) => person.windows[range].conversations > 0)
      .length ?? 0;
  const totalSpend =
    data?.people.reduce(
      (total, person) => total + person.windows[range].costUsd,
      0,
    ) ?? 0;
  const highestSpendPerson = data?.people.reduce<
    ActorSummaryReport | undefined
  >((best, person) => {
    if (!best) return person;
    return person.windows[range].costUsd > best.windows[range].costUsd
      ? person
      : best;
  }, undefined);
  const biggestIncreasePerson = data?.people.reduce<
    ActorSummaryReport | undefined
  >((best, person) => {
    const delta =
      person.windows[range].costUsd - person.windows[range].priorCostUsd;
    if (!best) return delta > 0 ? person : undefined;
    const bestDelta =
      best.windows[range].costUsd - best.windows[range].priorCostUsd;
    return delta > bestDelta ? person : best;
  }, undefined);
  const highestSpend = highestSpendPerson?.windows[range].costUsd ?? 0;
  const biggestIncrease = biggestIncreasePerson
    ? biggestIncreasePerson.windows[range].costUsd -
      biggestIncreasePerson.windows[range].priorCostUsd
    : 0;

  return (
    <SystemPageLayout>
      <PageHeader
        description={
          props.error
            ? "People failed to load."
            : `Who used ${getDashboardAgentName()} in the ${timeRangeDetail(range)}, and how spend changed from the prior period.`
        }
        onRangeChange={setRange}
        range={range}
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
              detail={`People with activity in the ${timeRangeDetail(range)}`}
              icon={Users}
              label="Active people"
              value={formatCompactNumber(activePeople)}
            />
            <StatCard
              detail={`Estimated model cost in the ${timeRangeDetail(range)}`}
              icon={CircleDollarSign}
              label="Model spend"
              value={formatCostSummary({ total: totalSpend }) || "$0.00"}
            />
            <StatCard
              detail={
                highestSpendPerson && highestSpend > 0
                  ? actorName(highestSpendPerson)
                  : "No spend in this range"
              }
              icon={Activity}
              label="Highest spend"
              value={
                highestSpendPerson && highestSpend > 0
                  ? formatCostSummary({ total: highestSpend }) || "$0.00"
                  : "—"
              }
            />
            <StatCard
              detail={
                biggestIncreasePerson && biggestIncrease > 0
                  ? `${actorName(biggestIncreasePerson)} vs prior period`
                  : "No spend increases in this range"
              }
              icon={TrendingUp}
              label="Biggest increase"
              value={
                biggestIncreasePerson && biggestIncrease > 0
                  ? formatSpendDelta(biggestIncrease)
                  : "—"
              }
            />
          </div>
          <PeopleActivityChart bucketUnit={bucketUnit} days={visibleActivity} />
          <PeopleDirectory
            loading={sort !== deferredSort}
            onQueryChange={setPeopleSearch}
            onSortChange={setSort}
            people={people}
            query={peopleSearch}
            range={range}
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
