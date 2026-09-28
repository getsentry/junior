import { useId, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "../../styles";
import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import { Button, ToggleButton } from "../../components/Button";
import { FilterGroup } from "../../components/FilterBar";
import { SearchInput } from "../../components/SearchInput";

/** Keep collection controls visible while a filtered page loads. */
export function AutomationFilters(props: {
  filters: AutomationListQuery;
  data: AutomationList | undefined;
  onChange(key: string, value: string): void;
  searchText: string;
  onSearch(value: string): void;
}) {
  const { filters, data, onChange } = props;
  const [expanded, setExpanded] = useState(false);
  const controlsId = useId();
  const activeCount = [
    filters.type !== "all",
    Boolean(filters.creator),
    Boolean(filters.destination),
    filters.state !== "all",
    filters.sort !== "newest",
  ].filter(Boolean).length;
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 lg:grid-cols-[auto_minmax(16rem,1fr)] lg:items-center lg:gap-4">
        <div aria-label="Scope" role="group" className="flex flex-wrap gap-2">
          {(
            [
              ["all", "All accessible"],
              ["mine", "Mine"],
              ["public", "Public"],
              ["attention", "Needs attention"],
            ] as const
          ).map(([value, label]) => (
            <ToggleButton
              className="min-h-11 normal-case lg:min-h-9"
              key={value}
              onClick={() => onChange("scope", value)}
              pressed={filters.scope === value}
              variant="pill"
            >
              {value === "all" ? (
                <>
                  <span className="lg:hidden">All</span>
                  <span className="hidden lg:inline">{label}</span>
                </>
              ) : (
                label
              )}
              {data && value !== "attention" ? (
                <span className="ml-1.5 opacity-65">{data.counts[value]}</span>
              ) : null}
            </ToggleButton>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            size="default"
            label="Search automations"
            placeholder="Title, instruction, or resource"
            value={props.searchText}
            onChange={props.onSearch}
          />
          <Button
            className="h-11 shrink-0 lg:hidden"
            aria-expanded={expanded}
            aria-controls={controlsId}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal aria-hidden="true" size={14} /> Filters
            {activeCount ? ` (${activeCount})` : ""}
          </Button>
        </div>
      </div>
      <div
        id={controlsId}
        className={cn(
          "grid-cols-2 items-end gap-3 lg:grid lg:grid-cols-4 xl:grid-cols-[auto_repeat(4,minmax(0,1fr))]",
          expanded ? "grid" : "hidden",
        )}
      >
        <FilterGroup
          className="col-span-2 lg:col-span-4 xl:col-span-1"
          label="Type"
        >
          {(["all", "scheduled", "event"] as const).map((value) => (
            <ToggleButton
              className="min-h-9"
              key={value}
              onClick={() => onChange("type", value)}
              pressed={filters.type === value}
              variant="pill"
            >
              {value}
            </ToggleButton>
          ))}
        </FilterGroup>
        <AutomationFilterSelect
          label="Creator"
          emptyLabel="All"
          value={filters.creator ?? ""}
          options={data?.creators ?? []}
          onChange={(value) => onChange("creator", value)}
        />
        <AutomationFilterSelect
          label="Destination"
          emptyLabel="All"
          value={filters.destination ?? ""}
          options={data?.destinations ?? []}
          onChange={(value) => onChange("destination", value)}
        />
        <AutomationFilterSelect
          label="State"
          emptyLabel="All"
          value={filters.state === "all" ? "" : filters.state}
          options={[
            { value: "active", label: "Active" },
            { value: "blocked", label: "Blocked" },
            { value: "paused", label: "Paused" },
            { value: "unavailable", label: "Trigger unavailable" },
            { value: "completed", label: "Completed" },
          ]}
          onChange={(value) => onChange("state", value)}
        />
        <AutomationFilterSelect
          label="Sort"
          ariaLabel="Sort automations"
          value={filters.sort}
          onChange={(value) => onChange("sort", value)}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
            { value: "title", label: "Title" },
          ]}
        />
      </div>
    </div>
  );
}

function AutomationFilterSelect(props: {
  label: string;
  ariaLabel?: string;
  emptyLabel?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  return (
    <FilterGroup label={props.label}>
      <select
        aria-label={props.ariaLabel ?? `Filter by ${props.label.toLowerCase()}`}
        className="h-9 w-full min-w-0 rounded-lg border border-dashboard-border-emphasis bg-dashboard-control px-2 text-sm text-dashboard-text transition-colors hover:border-dashboard-border-interactive focus:border-dashboard-focus focus:outline-none focus:ring-1 focus:ring-dashboard-focus/25 [color-scheme:var(--dashboard-color-scheme,dark)]"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {props.emptyLabel ? <option value="">{props.emptyLabel}</option> : null}
        {props.value &&
        !props.options.some((option) => option.value === props.value) ? (
          <option value={props.value}>{props.value}</option>
        ) : null}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FilterGroup>
  );
}
