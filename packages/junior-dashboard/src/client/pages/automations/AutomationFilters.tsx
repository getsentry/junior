import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import { ToggleButton } from "../../components/Button";
import { FilterBar, FilterGroup } from "../../components/FilterBar";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";

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
    <FilterBar
      search={{
        label: "Search automations",
        placeholder: "Title, instruction, or resource",
        value: props.searchText,
        onChange: props.onSearch,
      }}
    >
      <FilterGroup label="Scope">
        {(
          [
            ["all", "All accessible"],
            ["mine", "Mine"],
            ["public", "Public"],
          ] as const
        ).map(([value, label]) => (
          <ToggleButton
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
      <FilterGroup label="Type">
        {(["all", "scheduled", "event"] as const).map((value) => (
          <ToggleButton
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
        value={filters.creator ?? ""}
        options={data?.creators ?? []}
        onChange={(value) => onChange("creator", value)}
      />
      <AutomationFilterSelect
        label="Destination"
        value={filters.destination ?? ""}
        options={data?.destinations ?? []}
        onChange={(value) => onChange("destination", value)}
      />
      <AutomationFilterSelect
        label="State"
        value={filters.state === "all" ? "" : filters.state}
        options={[
          { value: "active", label: "Active" },
          { value: "blocked", label: "Blocked" },
          { value: "completed", label: "Completed" },
        ]}
        onChange={(value) => onChange("state", value)}
      />
      <DirectorySortSelect
        ariaLabel="Sort automations"
        value={filters.sort}
        onChange={(value) => onChange("sort", value)}
        options={[
          { value: "newest", label: "Newest first" },
          { value: "oldest", label: "Oldest first" },
          { value: "title", label: "Title" },
        ]}
      />
    </FilterBar>
  );
}

function AutomationFilterSelect(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void;
}) {
  return (
    <FilterGroup label={props.label}>
      <select
        aria-label={`Filter by ${props.label.toLowerCase()}`}
        className="h-9 max-w-48 rounded border border-dashboard-border-emphasis bg-dashboard-control px-2 text-sm text-dashboard-text [color-scheme:var(--dashboard-color-scheme,dark)]"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="">All</option>
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
