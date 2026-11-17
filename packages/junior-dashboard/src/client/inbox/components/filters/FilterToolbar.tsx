import { useEffect, useRef, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

import { useDetailsPanel } from "../../../components/DetailsPanel";
import { Button } from "../../../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip";

/** One filter that is set, as its removable chip shows it. */
export type ActiveFilter = {
  key: string;
  label: string;
  valueLabel: string;
};

/** The filters of a filtered page, as its toolbar controls them. */
type ToolbarFilters = {
  active: readonly ActiveFilter[];
  onRemove(key: string): void;
  onToggle(): void;
  open: boolean;
};

/**
 * The filter bar of a filtered page: the icon button that opens its
 * `FilterPanel`, and one removable chip per set filter. The command
 * palette is the search. Beside an open panel
 * the chips repeat it, so they hide. `children` adds controls after the
 * button, such as a sort. Render it as the `toolbar` of a `FilteredList`.
 */
export function FilterToolbar(props: {
  children?: ReactNode;
  filters?: ToolbarFilters;
}) {
  const { filters } = props;
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-end gap-2">
        {filters ? <FilterToggle filters={filters} /> : null}
        {props.children}
      </div>
      {filters ? <ActiveFilterChips filters={filters} /> : null}
    </div>
  );
}

/**
 * The button that opens a `FilterPanel`, with the count of set filters.
 * A page whose header bar holds it renders `ActiveFilterChips` as the
 * list's toolbar.
 */
export function FilterToggle(props: { filters: ToolbarFilters }) {
  const { filters } = props;
  const beside = useDetailsPanel();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(filters.open);
  useEffect(() => {
    // Closing the panel beside the list removes its focused close button.
    // Return focus to the toggle unless something else took it.
    if (
      wasOpen.current &&
      !filters.open &&
      document.activeElement === document.body
    ) {
      toggleRef.current?.focus();
    }
    wasOpen.current = filters.open;
  }, [filters.open]);
  // Beside the list, the open panel has its own close button.
  if (filters.open && beside) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            aria-expanded={filters.open}
            aria-label={
              filters.active.length
                ? `Filters ${filters.active.length}`
                : "Filters"
            }
            className="relative w-9 shrink-0 px-0"
            onClick={filters.onToggle}
            ref={toggleRef}
          >
            <SlidersHorizontal aria-hidden="true" size={15} />
            {filters.active.length ? (
              <span
                aria-hidden="true"
                className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-dashboard-text-solid px-1 text-2xs font-semibold tabular-nums text-dashboard-text-inverse"
              >
                {filters.active.length}
              </span>
            ) : null}
          </Button>
        }
      />
      <TooltipContent size="compact">Filters</TooltipContent>
    </Tooltip>
  );
}

/** One removable chip per set filter. Beside an open panel they hide. */
export function ActiveFilterChips(props: { filters: ToolbarFilters }) {
  const { filters } = props;
  const beside = useDetailsPanel();
  if (filters.active.length === 0 || (filters.open && beside)) return null;
  return (
    <div
      aria-label="Active filters"
      className="flex min-w-0 flex-wrap gap-2"
      role="group"
    >
      {filters.active.map((filter) => (
        <Button
          variant="outline"
          aria-label={`Remove ${filter.key} filter`}
          className="min-h-8 max-w-full text-xs"
          key={filter.key}
          onClick={() => filters.onRemove(filter.key)}
          title={`${filter.label}: ${filter.valueLabel}`}
        >
          <span className="truncate">
            <span className="text-dashboard-text-muted">{filter.label}</span>{" "}
            {filter.valueLabel}
          </span>
          <X aria-hidden="true" className="shrink-0" size={12} />
        </Button>
      ))}
    </div>
  );
}
