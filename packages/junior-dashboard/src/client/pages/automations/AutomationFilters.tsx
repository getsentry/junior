import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import { ToggleButton } from "../../components/Button";
import { FilterGroup } from "../../components/FilterBar";
import { Card } from "../../components/layout/Card";
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
  return (
    <Card className="grid gap-4 p-4">
      <div className="grid items-end gap-4 lg:grid-cols-[auto_minmax(16rem,1fr)]">
        <FilterGroup label="Scope">
          {(
            [
              ["all", "All accessible"],
              ["mine", "Mine"],
              ["public", "Public"],
            ] as const
          ).map(([value, label]) => (
            <ToggleButton
              className="min-h-9"
              key={value}
              onClick={() => onChange("scope", value)}
              pressed={filters.scope === value}
              variant="pill"
            >
              {label}
              {data ? (
                <span className="ml-1.5 opacity-65">{data.counts[value]}</span>
              ) : null}
            </ToggleButton>
          ))}
        </FilterGroup>
        <SearchInput
          label="Search automations"
          placeholder="Title, instruction, or resource"
          value={props.searchText}
          onChange={props.onSearch}
        />
      </div>
      <div className="grid grid-cols-2 items-end gap-3 border-t border-dashboard-border-subtle pt-4 sm:grid-cols-4 xl:grid-cols-[auto_repeat(4,minmax(0,1fr))]">
        <FilterGroup
          className="col-span-2 sm:col-span-4 xl:col-span-1"
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
    </Card>
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
