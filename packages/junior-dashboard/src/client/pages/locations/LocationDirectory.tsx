import { Hash } from "lucide-react";
import { Link } from "react-router";
import type { LocationSummaryReport } from "@sentry/junior/api/schema";

import { ConversationSearchInput } from "../../components/ConversationListControls";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { Card } from "../../components/layout/Card";
import { DirectoryMetric } from "../../components/metrics/DirectoryMetric";
import {
  formatCompactNumber,
  formatMs,
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
  onQueryChange(value: string): void;
  onSortChange(value: LocationSort): void;
}) {
  return (
    <Card>
      <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
        <h3 className="m-0 font-mono text-[0.68rem] font-medium uppercase tracking-[0.14em] text-white/60">
          Public directory
        </h3>
        <p className="mt-1 mb-0 font-mono text-[0.68rem] leading-relaxed text-white/30">
          {props.locations.length} of {props.totalLocations} public locations
        </p>
      </div>
      <div className="grid min-w-0 gap-2 border-b border-white/[0.06] bg-black/15 p-3 md:grid-cols-[minmax(14rem,1fr)_minmax(11rem,15rem)]">
        <ConversationSearchInput
          label="Search locations"
          placeholder="Search channel name..."
          value={props.query}
          onChange={props.onQueryChange}
        />
        <label className="grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-white/[0.08] bg-black/25 focus-within:border-amber-500/30 focus-within:ring-1 focus-within:ring-amber-500/15">
          <span className="flex h-full items-center border-r border-white/[0.07] px-2 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-white/30">
            Sort
          </span>
          <select
            aria-label="Sort locations"
            className="h-full min-w-0 bg-transparent px-2 font-mono text-[0.72rem] text-white/70 outline-none"
            value={props.sort}
            onChange={(event) =>
              props.onSortChange(event.currentTarget.value as LocationSort)
            }
          >
            <option value="recent">Recently active</option>
            <option value="conversations">Most conversations</option>
            <option value="tokens">Most tokens</option>
            <option value="runtime">Most runtime</option>
          </select>
        </label>
      </div>
      {props.locations.length ? (
        <div className="min-w-0" role="table">
          <div className="grid grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-4 border-b border-white/[0.06] bg-black/20 px-4 py-2.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-white/30 max-md:hidden">
            <div>Location</div>
            <div className="justify-self-end">Conversations</div>
            <div className="justify-self-end">Tokens</div>
            <div className="justify-self-end">Runtime</div>
          </div>
          {props.locations.map((location) => (
            <Link
              className="group grid min-w-0 grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-4 border-b border-white/[0.055] px-4 py-3.5 text-inherit no-underline transition-colors last:border-b-0 hover:bg-white/[0.035] max-md:grid-cols-3 max-md:gap-x-3 max-md:gap-y-4"
              key={location.id}
              to={locationPath(location.id)}
            >
              <div className="flex min-w-0 items-center gap-3 max-md:col-span-3">
                <span className="grid size-9 shrink-0 place-items-center rounded border border-white/10 bg-cyan-400/[0.06] text-cyan-300 transition-colors group-hover:border-cyan-400/25">
                  <Hash aria-hidden="true" size={16} strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className="truncate font-display text-[1rem] font-medium leading-tight text-white/90">
                    {location.label}
                  </div>
                  <div className="mt-1 truncate font-mono text-[0.68rem] leading-tight text-white/35">
                    Last active {formatRelativeTime(location.lastSeenAt)}
                  </div>
                </div>
              </div>
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
                value={formatMs(location.durationMs)}
              />
            </Link>
          ))}
        </div>
      ) : (
        <div className="p-4">
          <EmptyTelemetry>
            No public locations match this search.
          </EmptyTelemetry>
        </div>
      )}
    </Card>
  );
}
