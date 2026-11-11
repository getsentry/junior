import { useState } from "react";
import { Check, SlidersHorizontal, X } from "lucide-react";
import type {
  AutomationList,
  AutomationListQuery,
} from "@sentry/junior/api/schema";
import { DetailsPanel, useDetailsPanel } from "../../components/DetailsPanel";
import { SearchInput } from "../../components/SearchInput";
import { Button } from "../../components/ui/button";
import { cn } from "../../styles";

type FilterOption = { value: string; label: string };

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

// Long creator and destination lists show this many options until expanded.
const COLLAPSED_OPTIONS = 6;

/** The filters set in the URL, with the labels their chips show. */
function activeFilters({ filters, data }: Omit<FilterProps, "onChange">) {
  const label = (options: FilterOption[] | undefined, value?: string) =>
    options?.find((option) => option.value === value)?.label ?? value;
  return [
    {
      key: "type",
      label: "Type",
      value: filters.type === "all" ? "" : filters.type,
      valueLabel: label(typeOptions, filters.type),
    },
    {
      key: "creator",
      label: "Creator",
      value: filters.creator,
      valueLabel: label(data?.creators, filters.creator),
    },
    {
      key: "destination",
      label: "Destination",
      value: filters.destination,
      valueLabel: label(data?.destinations, filters.destination),
    },
    {
      key: "state",
      label: "State",
      value: filters.state === "all" ? "" : filters.state,
      valueLabel: label(stateOptions, filters.state),
    },
  ].filter((filter) => filter.value);
}

/**
 * Search, the button that opens the filter panel, and one removable chip per
 * URL filter. Beside an open panel the chips repeat it, so they hide.
 */
export function AutomationFilterToolbar(
  props: FilterProps & {
    onSearch(value: string): void;
    onToggle(): void;
    open: boolean;
    searchText: string;
  },
) {
  const { onChange } = props;
  const beside = useDetailsPanel();
  const active = activeFilters(props);
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          size="default"
          label="Search automations"
          placeholder="Search automations"
          value={props.searchText}
          onChange={props.onSearch}
        />
        <Button
          aria-expanded={props.open}
          className={cn(
            "h-11 shrink-0",
            props.open && "bg-dashboard-surface-active",
          )}
          onClick={props.onToggle}
        >
          <SlidersHorizontal aria-hidden="true" size={14} />
          Filters
          {active.length ? (
            <span className="ml-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-dashboard-text-solid px-1.5 text-2xs font-semibold tabular-nums text-dashboard-text-inverse">
              {active.length}
            </span>
          ) : null}
        </Button>
      </div>
      {active.length > 0 && !(props.open && beside) ? (
        <div
          aria-label="Active filters"
          role="group"
          className="flex min-w-0 flex-wrap gap-2"
        >
          {active.map((filter) => (
            <Button
              key={filter.key}
              aria-label={`Remove ${filter.key} filter`}
              className="min-h-8 max-w-full text-xs"
              title={`${filter.label}: ${filter.valueLabel}`}
              onClick={() => onChange(filter.key, "")}
            >
              <span className="truncate">
                <span className="text-dashboard-text-muted">
                  {filter.label}
                </span>{" "}
                {filter.valueLabel}
              </span>
              <X aria-hidden="true" className="shrink-0" size={12} />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Edit the URL filters in a column beside the list, or in a bottom sheet
 * where the column does not fit. Each filter is a short list of options, so
 * every choice is visible without opening a menu.
 */
export function AutomationFilterPanel(
  props: FilterProps & { onClear(): void; onClose(): void },
) {
  const { filters, data, onChange } = props;
  const active = activeFilters(props);
  return (
    <DetailsPanel
      actions={
        active.length ? (
          <Button onClick={props.onClear} variant="quiet">
            Clear all
          </Button>
        ) : undefined
      }
      label="Filters"
      onClose={props.onClose}
      title={
        <h2 className="m-0 font-display text-base font-medium text-dashboard-text">
          Filters
        </h2>
      }
    >
      <div className="grid gap-5 px-3 py-4">
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
      </div>
    </DetailsPanel>
  );
}

/**
 * One filter as a list of pressable options under a heading. "All" clears
 * it. A long list shows its first options and the selected one until it is
 * expanded.
 */
function FilterOptions(props: {
  label: string;
  onChange(value: string): void;
  options: FilterOption[];
  value: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // A shared URL can select a value that the loaded options do not list.
  const options =
    props.value && !props.options.some((option) => option.value === props.value)
      ? [...props.options, { label: props.value, value: props.value }]
      : props.options;
  const hidden = expanded ? 0 : Math.max(0, options.length - COLLAPSED_OPTIONS);
  const shown = hidden
    ? options.filter(
        (option, index) =>
          index < COLLAPSED_OPTIONS || option.value === props.value,
      )
    : options;
  return (
    <section aria-label={props.label} className="grid gap-1">
      <h3 className="m-0 px-2 pb-1 font-sans text-xs font-medium text-dashboard-text-muted">
        {props.label}
      </h3>
      <div aria-label={`Filter by ${props.label.toLowerCase()}`} role="group">
        {[{ label: "All", value: "" }, ...shown].map((option) => (
          <FilterOptionButton
            key={option.value || "all"}
            label={option.label}
            onClick={() => props.onChange(option.value)}
            selected={option.value === props.value}
            // "All" is the default, so only a chosen option stands out.
            subtle={!option.value}
          />
        ))}
      </div>
      {options.length > COLLAPSED_OPTIONS ? (
        <button
          className="w-fit cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 font-sans text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}

function FilterOptionButton(props: {
  label: string;
  onClick(): void;
  selected: boolean;
  subtle: boolean;
}) {
  return (
    <button
      aria-pressed={props.selected}
      className={cn(
        "flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 bg-transparent px-2 py-1 text-left font-sans text-sm transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
        !props.selected
          ? "text-dashboard-text-muted hover:text-dashboard-text"
          : props.subtle
            ? "text-dashboard-text"
            : "bg-dashboard-surface-active font-medium text-dashboard-text",
      )}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <span className="min-w-0 truncate">{props.label}</span>
      {props.selected && !props.subtle ? (
        <Check aria-hidden="true" className="shrink-0" size={14} />
      ) : null}
    </button>
  );
}
