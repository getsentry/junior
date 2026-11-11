import { useEffect, useRef, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

import { useDetailsPanel } from "../DetailsPanel";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** One filter that is set, as its removable chip shows it. */
export type ActiveFilter = {
  key: string;
  label: string;
  valueLabel: string;
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
  filters?: {
    active: readonly ActiveFilter[];
    onRemove(key: string): void;
    onToggle(): void;
    open: boolean;
  };
}) {
  const { filters } = props;
  const beside = useDetailsPanel();
  const open = filters?.open ?? false;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    // Closing the panel beside the list removes its focused close button.
    // Return focus to the toggle unless something else took it.
    if (wasOpen.current && !open && document.activeElement === document.body) {
      toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  const chips =
    filters && filters.active.length > 0 && !(filters.open && beside)
      ? filters.active
      : [];
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-end gap-2">
        {/* Beside the list, the open panel has its own close button. */}
        {filters && !(filters.open && beside) ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
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
        ) : null}
        {props.children}
      </div>
      {chips.length > 0 ? (
        <div
          aria-label="Active filters"
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
        >
          {chips.map((filter) => (
            <Button
              aria-label={`Remove ${filter.key} filter`}
              className="min-h-8 max-w-full text-xs"
              key={filter.key}
              onClick={() => filters?.onRemove(filter.key)}
              title={`${filter.label}: ${filter.valueLabel}`}
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
