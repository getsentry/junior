import { useState, useSyncExternalStore } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import { BottomSheet } from "../../components/BottomSheet";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../../components/ui/popover";
import { Button } from "../../components/ui/button";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";
import { FilterGroup } from "../../components/FilterBar";
import { SearchInput } from "../../components/SearchInput";
import { NativeSelect } from "../../components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";

const filterMediaQuery = "(min-width: 768px)";
const stateOptions = [
  { value: "active", label: "Active" },
  { value: "blocked", label: "Blocked" },
  { value: "paused", label: "Paused" },
  { value: "unavailable", label: "Trigger unavailable" },
  { value: "completed", label: "Completed" },
];

function subscribeToFilterLayout(onChange: () => void) {
  const media = window.matchMedia(filterMediaQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function filtersFitPopover() {
  return window.matchMedia(filterMediaQuery).matches;
}

/** Keep URL filters visible while editing them in a popover or mobile sheet. */
export function AutomationFilters(props: {
  filters: AutomationListQuery;
  data: AutomationList | undefined;
  onChange(key: string, value: string): void;
  searchText: string;
  onSearch(value: string): void;
}) {
  const { filters, data, onChange } = props;
  const [expanded, setExpanded] = useState(false);
  const desktop = useSyncExternalStore(
    subscribeToFilterLayout,
    filtersFitPopover,
    () => false,
  );
  const activeFilters = [
    {
      key: "type",
      label: "Type",
      value: filters.type === "all" ? "" : filters.type,
      text: filters.type === "scheduled" ? "Scheduled" : "Event",
    },
    {
      key: "creator",
      label: "Creator",
      value: filters.creator,
      text:
        data?.creators.find((option) => option.value === filters.creator)
          ?.label ?? filters.creator,
    },
    {
      key: "destination",
      label: "Destination",
      value: filters.destination,
      text:
        data?.destinations.find(
          (option) => option.value === filters.destination,
        )?.label ?? filters.destination,
    },
    {
      key: "state",
      label: "State",
      value: filters.state === "all" ? "" : filters.state,
      text: stateOptions.find((option) => option.value === filters.state)
        ?.label,
    },
  ].filter((filter) => filter.value);
  const trigger = (
    <Button
      className="h-11 shrink-0"
      aria-expanded={expanded}
      aria-haspopup="dialog"
      onClick={desktop ? undefined : () => setExpanded(true)}
    >
      <SlidersHorizontal aria-hidden="true" size={14} /> Filters
      {activeFilters.length ? ` (${activeFilters.length})` : ""}
    </Button>
  );
  const controls = (
    <AutomationFilterFields filters={filters} data={data} onChange={onChange} />
  );
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 lg:grid-cols-[auto_minmax(16rem,1fr)] lg:items-center lg:gap-4">
        <ToggleGroup
          aria-label="Scope"
          className="flex-wrap gap-2"
          onValueChange={([next]) => {
            if (next) onChange("scope", next);
          }}
          value={[filters.scope]}
        >
          {(
            [
              ["all", "All"],
              ["mine", "Mine"],
              ["public", "Public"],
              ["attention", "Needs attention"],
            ] as const
          ).map(([value, label]) => (
            <ToggleGroupItem
              className="min-h-11 lg:min-h-9"
              key={value}
              value={value}
              variant="pill"
            >
              {label}
              {data && value !== "attention" ? (
                <span className="ml-1.5 opacity-65">{data.counts[value]}</span>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            size="default"
            label="Search automations"
            placeholder="Search automations"
            value={props.searchText}
            onChange={props.onSearch}
          />
          {desktop ? (
            <Popover open={expanded} onOpenChange={setExpanded}>
              <PopoverTrigger render={trigger} />
              <PopoverContent align="end" className="w-80">
                <PopoverTitle>Filters</PopoverTitle>
                <div className="mt-4">{controls}</div>
              </PopoverContent>
            </Popover>
          ) : (
            trigger
          )}
        </div>
      </div>
      {activeFilters.length > 0 ? (
        <div
          aria-label="Active filters"
          role="group"
          className="flex min-w-0 flex-wrap gap-2"
        >
          {activeFilters.map((filter) => (
            <Button
              key={filter.key}
              aria-label={`Remove ${filter.key} filter`}
              className="min-h-9 max-w-full text-xs"
              title={`${filter.label}: ${filter.text}`}
              onClick={() => onChange(filter.key, "")}
            >
              <span className="truncate">
                {filter.label}: {filter.text}
              </span>
              <X aria-hidden="true" className="shrink-0" size={12} />
            </Button>
          ))}
        </div>
      ) : null}
      {!desktop && expanded ? (
        <BottomSheet
          label="Filters"
          size="content"
          onClose={() => setExpanded(false)}
        >
          <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {controls}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}

function AutomationFilterFields({
  filters,
  data,
  onChange,
}: Pick<
  Parameters<typeof AutomationFilters>[0],
  "filters" | "data" | "onChange"
>) {
  return (
    <div className="grid gap-4">
      <FilterGroup label="Type">
        <ToggleGroup
          className="flex-wrap gap-2"
          onValueChange={([next]) => {
            if (next) onChange("type", next);
          }}
          value={[filters.type]}
        >
          {(["all", "scheduled", "event"] as const).map((value) => (
            <ToggleGroupItem
              className="min-h-9"
              key={value}
              value={value}
              variant="pill"
            >
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
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
        options={stateOptions}
        onChange={(value) => onChange("state", value)}
      />
    </div>
  );
}

/** Keep list order visible beside the result count instead of inside Filters. */
export function AutomationSort(props: {
  value: AutomationListQuery["sort"];
  onChange(value: string): void;
}) {
  return (
    <DirectorySortSelect
      ariaLabel="Sort automations"
      onChange={props.onChange}
      options={[
        { value: "newest", label: "Recently created" },
        { value: "oldest", label: "Oldest created" },
        { value: "title", label: "Title A–Z" },
      ]}
      value={props.value}
    />
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
      <NativeSelect
        aria-label={props.ariaLabel ?? `Filter by ${props.label.toLowerCase()}`}
        variant="filter"
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
      </NativeSelect>
    </FilterGroup>
  );
}
