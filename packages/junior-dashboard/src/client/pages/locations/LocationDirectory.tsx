import { Duration } from "../../components/Duration";
import { Hash } from "lucide-react";
import type { LocationSummaryReport } from "@sentry/junior/api/schema";

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
import {
  formatCompactNumber,
  formatRelativeTime,
  locationPath,
} from "../../format";

export type LocationSort = "conversations" | "recent" | "runtime" | "tokens";

/** Render searchable public locations with compact activity metrics. */
export function LocationDirectory(props: {
  locations: LocationSummaryReport[];
  query: string;
  sort: LocationSort;
  totalLocations: number;
  loading?: boolean;
  onQueryChange(value: string): void;
  onSortChange(value: LocationSort): void;
}) {
  return (
    <Card>
      <CardHeader
        description={`${props.locations.length} of ${props.totalLocations} public locations`}
        title="Public directory"
      />
      <DirectoryToolbar columnsClassName="md:grid-cols-[minmax(14rem,1fr)_minmax(11rem,15rem)]">
        <SearchInput
          label="Search locations"
          placeholder="Search channel name..."
          value={props.query}
          onChange={props.onQueryChange}
        />
        <DirectorySortSelect
          ariaLabel="Sort locations"
          onChange={(value) => props.onSortChange(value as LocationSort)}
          options={[
            { label: "Most conversations", value: "conversations" },
            { label: "Recently active", value: "recent" },
            { label: "Most tokens", value: "tokens" },
            { label: "Most runtime", value: "runtime" },
          ]}
          value={props.sort}
        />
      </DirectoryToolbar>
      <DirectoryTable
        ariaLabel="Public location directory results"
        empty={
          props.locations.length === 0 ? (
            <EmptyTelemetry>
              No public locations match this search.
            </EmptyTelemetry>
          ) : undefined
        }
        headers={["Location", "Conversations", "Tokens", "Runtime"]}
        loading={props.loading}
      >
        {props.locations.map((location) => (
          <DirectoryRow key={location.id} to={locationPath(location.id)}>
            <DirectoryIdentity
              description={
                <>Last active {formatRelativeTime(location.lastSeenAt)}</>
              }
              icon={<Hash aria-hidden="true" size={16} strokeWidth={1.8} />}
              iconClassName="bg-cyan-400/[0.06] text-cyan-300 group-hover:border-cyan-400/25"
              title={location.label}
            />
            <DirectoryMetric
              label="Conversations"
              value={formatCompactNumber(location.conversations)}
            />
            <DirectoryMetric
              label="Tokens"
              value={formatCompactNumber(location.tokens ?? 0)}
            />
            <DirectoryMetric
              label="Runtime"
              value={<Duration value={location.durationMs} />}
            />
          </DirectoryRow>
        ))}
      </DirectoryTable>
    </Card>
  );
}
