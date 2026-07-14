import { Clock3, LockKeyhole, MapPinned, MessageSquare } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  LocationDirectoryReport,
  LocationSummaryReport,
} from "@sentry/junior/api/schema";

import { useLocationDirectoryData } from "../../api";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { StatCard } from "../../components/metrics/StatCard";
import { formatCompactNumber, formatMs } from "../../format";
import { cn, dashboardContainerClass } from "../../styles";
import { LocationDirectoryActivityChart } from "./LocationDirectoryActivityChart";
import { LocationDirectory, type LocationSort } from "./LocationDirectory";
import { PrivateActivityCard } from "./PrivateActivityCard";

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
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<LocationSort>("conversations");
  const deferredSort = useDeferredValue(sort);
  const search = params.get("q") ?? "";
  if (!props.data && !props.error) {
    return <LoadingView label="Loading locations" />;
  }

  const locations = filterLocations(
    props.data?.locations ?? [],
    search,
    deferredSort,
  );
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

  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value.trim()) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  }

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid min-w-0 gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8",
      )}
    >
      <PageHeader
        description={
          props.error && !props.data
            ? "Locations failed to load."
            : "See the public channels where Junior has been working and how busy they've been."
        }
        eyebrow="Where Junior's working"
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
              value={formatMs(totalRuntime)}
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
          <LocationDirectoryActivityChart days={props.data.activityDays} />
          <LocationDirectory
            loading={sort !== deferredSort}
            locations={locations}
            onQueryChange={setSearch}
            onSortChange={setSort}
            query={search}
            sort={sort}
            totalLocations={props.data.locations.length}
          />
          {props.data.privateActivity.conversations > 0 ? (
            <PrivateActivityCard item={props.data.privateActivity} />
          ) : null}
        </>
      ) : null}
    </div>
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
