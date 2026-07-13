import { Link } from "react-router";
import type { LocationSummaryReport } from "@sentry/junior/api/schema";

import { formatCompactNumber, formatMs, locationPath } from "../format";
import { EmptyTelemetry } from "./EmptyTelemetry";
import { Section } from "./Section";
import { SectionHeader } from "./SectionHeader";
import { SectionTitle } from "./SectionTitle";

/** Render the highest-volume public locations on the command center. */
export function LocationPulse(props: {
  error?: boolean;
  loading?: boolean;
  locations: LocationSummaryReport[] | undefined;
}) {
  const locations = props.locations ?? [];
  const active = [...locations]
    .sort(
      (left, right) =>
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    )
    .slice(0, 5);
  if (!locations.length && !props.error && !props.loading) return null;

  return (
    <Section>
      <SectionHeader
        actions={
          <Link
            className="text-[0.76rem] font-semibold uppercase text-[#beaaff] no-underline hover:text-white"
            to="/locations"
          >
            View all
          </Link>
        }
      >
        <SectionTitle>Locations</SectionTitle>
      </SectionHeader>
      {props.error && !locations.length ? (
        <div className="p-3">
          <EmptyTelemetry>Location activity failed to load.</EmptyTelemetry>
        </div>
      ) : props.loading && !locations.length ? (
        <div className="px-4 py-4 text-[0.82rem] text-[#777]">
          Loading location activity...
        </div>
      ) : (
        <LocationGroup items={active} title="Most active" />
      )}
    </Section>
  );
}

function LocationGroup(props: {
  items: LocationSummaryReport[];
  title: string;
}) {
  return (
    <div className="min-w-0 border-r border-white/10 last:border-r-0">
      <div className="border-b border-white/10 px-4 py-2 text-[0.7rem] font-semibold uppercase text-[#777]">
        {props.title}
      </div>
      {props.items.length ? (
        props.items.map((item) => (
          <Link
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-white/10 px-4 py-3 text-inherit no-underline last:border-b-0 hover:bg-white/5"
            key={item.id}
            to={locationPath(item.id)}
          >
            <div className="min-w-0">
              <div className="truncate font-semibold text-white">
                {item.label}
              </div>
              <div className="mt-1 truncate text-[0.76rem] text-[#888]">
                {formatCompactNumber(item.tokens ?? 0)} tokens /{" "}
                {formatMs(item.durationMs)} runtime
              </div>
            </div>
            <div className="text-xl font-extrabold text-white">
              {formatCompactNumber(item.conversations)}
            </div>
          </Link>
        ))
      ) : (
        <div className="px-4 py-4 text-[0.82rem] text-[#666]">
          No location activity yet.
        </div>
      )}
    </div>
  );
}
