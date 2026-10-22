import { useState } from "react";
import type { CodeChangeSummaryReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { FilterGroup } from "../../components/FilterBar";
import { Select } from "../../components/Select";
import { Card } from "../../components/layout/Card";
import { CodeChangeRow } from "../code/CodeChangeRow";

const DAY_MS = 24 * 60 * 60 * 1_000;

const STATE_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Merged", value: "merged" },
  { label: "Closed", value: "closed" },
  { label: "All", value: "" },
] as const;

const OPENED_OPTIONS = [
  { label: "Any time", value: "" },
  { label: "Last 24 hours", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
] as const;

/**
 * List one person's recent code changes. Open changes show first, and the
 * person can filter by state and by the date the change was opened.
 */
export function ProfileCodeChanges(props: {
  changes: CodeChangeSummaryReport[];
  generatedAt: string;
}) {
  const [state, setState] = useState("open");
  const [openedDays, setOpenedDays] = useState("");
  const openedSinceMs = openedDays
    ? Date.parse(props.generatedAt) - Number(openedDays) * DAY_MS
    : undefined;
  const inDateRange = props.changes.filter(
    (change) =>
      openedSinceMs === undefined ||
      Date.parse(change.openedAt) >= openedSinceMs,
  );
  const changes = inDateRange.filter(
    (change) => !state || change.state === state,
  );
  const count = (value: string) =>
    value
      ? inDateRange.filter((change) => change.state === value).length
      : inDateRange.length;
  return (
    <Card as="section">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-dashboard-border-subtle px-4 py-3">
        <div className="font-display text-lg text-dashboard-text">
          Recent changes
        </div>
        <div className="flex flex-wrap gap-3">
          <FilterGroup className="w-36" label="State">
            <Select
              aria-label="Filter changes by state"
              onChange={(event) => setState(event.currentTarget.value)}
              value={state}
            >
              {STATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({count(option.value)})
                </option>
              ))}
            </Select>
          </FilterGroup>
          <FilterGroup className="w-36" label="Opened">
            <Select
              aria-label="Filter changes by opened date"
              onChange={(event) => setOpenedDays(event.currentTarget.value)}
              value={openedDays}
            >
              {OPENED_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FilterGroup>
        </div>
      </div>
      {changes.length > 0 ? (
        <div>
          {changes.map((change) => (
            <CodeChangeRow change={change} key={change.id} />
          ))}
        </div>
      ) : (
        <div className="p-4">
          <EmptyTelemetry>
            {state && inDateRange.length > 0
              ? `No ${state} changes. Set State to All to see ${inDateRange.length} more.`
              : "No changes match these filters."}
          </EmptyTelemetry>
        </div>
      )}
    </Card>
  );
}
