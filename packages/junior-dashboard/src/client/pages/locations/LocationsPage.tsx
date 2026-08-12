import { Duration } from "../../components/Duration";
import { Clock3, LockKeyhole, MapPinned, MessageSquare } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type {
  LocationDirectoryReport,
  LocationSummaryReport,
} from "@sentry/junior/api/schema";

import { useLocationDirectoryData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import type { TimeRangeDays } from "../../components/controls/TimeRangeSelector";
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
import { LocationDirectoryActivityChart } from "./LocationDirectoryActivityChart";
import { LocationDirectory, type LocationSort } from "./LocationDirectory";
import { PrivateActivityCard } from "./PrivateActivityCard";

const LOCATION_SORTS = [
  "conversations",
  "recent",
  "runtime",
  "tokens",
] as const satisfies readonly LocationSort[];

/** Render the searchable directory of persisted public conversation locations. */
export function LocationsPage() {
  const query = useLocationDirectoryData();
  return <LocationsPageContent data={query.data} error={query.error} />;
}

/** Render loaded, failed, and empty public-location directory states. */
export function LocationsPageContent(props: {
  data: LocationDirectoryReport | undefined;
  error: unknown;
}) {
  const [range, setRange] = useState<TimeRangeDays>(90);
  const [sort, setSort] = useSearchParamEnum(
    "sort",
    "conversations",
    LOCATION_SORTS,
  );
  const deferredSort = useDeferredValue(sort);
  const [searchText, setSearchText, search] = useDebouncedSearchParam();
  if (!props.data && !props.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading locations" />
      </SystemPageLayout>
    );
  }

  const locations = filterLocations(
    props.data?.locations ?? [],
    search,
    deferredSort,
  );
  const visibleActivity = props.data?.activityDays.slice(-range) ?? [];
  const publicConversations =
    props.data?.locations.reduce(
      (total, location) => total + location.conversations,
      0,
    ) ?? 0;
  const totalRuntime =
    props.data?.locations.reduce(
      (total, location) => total + location.durationMs,
      0,
    ) ?? 0;

  return (
    <SystemPageLayout>
      <PageHeader
        description={
          props.error && !props.data
            ? "Locations failed to load."
            : `See the public channels where ${getDashboardAgentName()} has been working and how busy they've been.`
        }
        onRangeChange={setRange}
        range={range}
        title="Locations"
      />
      {props.error ? (
        <Card padding="sm">
          <EmptyTelemetry>
            {props.data
              ? "Location telemetry refresh failed. Showing cached data."
              : "Location telemetry is unavailable. Try refreshing the dashboard."}
          </EmptyTelemetry>
        </Card>
      ) : null}
      {props.data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              detail="Named public destinations"
              icon={MapPinned}
              label="Public locations"
              value={formatCompactNumber(props.data.locations.length)}
            />
            <StatCard
              detail="Across public destinations"
              icon={MessageSquare}
              label="Conversations"
              value={formatCompactNumber(publicConversations)}
            />
            <StatCard
              detail="Cumulative public runtime"
              icon={Clock3}
              label="Runtime"
              value={<Duration value={totalRuntime} />}
            />
            <StatCard
              detail="Combined to preserve privacy"
              icon={LockKeyhole}
              label="Private conversations"
              value={formatCompactNumber(
                props.data.privateActivity.conversations,
              )}
            />
          </div>
          <LocationDirectoryActivityChart days={visibleActivity} />
          <LocationDirectory
            loading={sort !== deferredSort}
            locations={locations}
            onQueryChange={setSearchText}
            onSortChange={setSort}
            query={searchText}
            sort={sort}
            totalLocations={props.data.locations.length}
          />
          {props.data.privateActivity.conversations > 0 ? (
            <PrivateActivityCard item={props.data.privateActivity} />
          ) : null}
        </>
      ) : null}
    </SystemPageLayout>
  );
}

function filterLocations(
  locations: LocationSummaryReport[],
  query: string,
  sort: LocationSort,
): LocationSummaryReport[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? locations.filter((location) =>
        location.label.toLowerCase().includes(normalized),
      )
    : locations;
  return [...filtered].sort((left, right) => {
    if (sort === "conversations") {
      return right.conversations - left.conversations;
    }
    if (sort === "runtime") return right.durationMs - left.durationMs;
    if (sort === "tokens") return (right.tokens ?? 0) - (left.tokens ?? 0);
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}
