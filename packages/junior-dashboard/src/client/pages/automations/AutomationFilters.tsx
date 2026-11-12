import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import {
  FilterOptions,
  FilterPanel,
  type FilterOption,
} from "../../components/filters/FilterPanel";
import type { ActiveFilter } from "../../components/filters/FilterToolbar";

type FilterProps = {
  filters: AutomationListQuery;
  data: AutomationList | undefined;
  onChange(key: string, value: string): void;
};

const typeOptions: FilterOption[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "event", label: "Event" },
];

const stateOptions: FilterOption[] = [
  { value: "active", label: "Active" },
  { value: "blocked", label: "Blocked" },
  { value: "paused", label: "Paused" },
  { value: "unavailable", label: "Trigger unavailable" },
  { value: "completed", label: "Completed" },
];

/** The Automation list filters set in the URL, labeled for their chips. */
export function activeAutomationFilters({
  filters,
  data,
}: Omit<FilterProps, "onChange">): ActiveFilter[] {
  const label = (options: FilterOption[] | undefined, value: string) =>
    options?.find((option) => option.value === value)?.label ?? value;
  const set = [
    {
      key: "type",
      label: "Type",
      value: filters.type === "all" ? "" : filters.type,
      options: typeOptions,
    },
    {
      key: "creator",
      label: "Creator",
      value: filters.creator ?? "",
      options: data?.creators,
    },
    {
      key: "destination",
      label: "Destination",
      value: filters.destination ?? "",
      options: data?.destinations,
    },
    {
      key: "state",
      label: "State",
      value: filters.state === "all" ? "" : filters.state,
      options: stateOptions,
    },
  ];
  return set
    .filter((filter) => filter.value)
    .map((filter) => ({
      key: filter.key,
      label: filter.label,
      valueLabel: label(filter.options, filter.value),
    }));
}

/** Edit the Automation list filters: Type, State, Creator, and Destination. */
export function AutomationFilterPanel(
  props: FilterProps & { onClear(): void; onClose(): void },
) {
  const { filters, data, onChange } = props;
  return (
    <FilterPanel
      onClear={
        activeAutomationFilters(props).length ? props.onClear : undefined
      }
      onClose={props.onClose}
    >
      <FilterOptions
        label="Type"
        onChange={(value) => onChange("type", value)}
        options={typeOptions}
        value={filters.type === "all" ? "" : filters.type}
      />
      <FilterOptions
        label="State"
        onChange={(value) => onChange("state", value)}
        options={stateOptions}
        value={filters.state === "all" ? "" : filters.state}
      />
      <FilterOptions
        label="Creator"
        onChange={(value) => onChange("creator", value)}
        options={data?.creators ?? []}
        value={filters.creator ?? ""}
      />
      <FilterOptions
        label="Destination"
        onChange={(value) => onChange("destination", value)}
        options={data?.destinations ?? []}
        value={filters.destination ?? ""}
      />
    </FilterPanel>
  );
}
