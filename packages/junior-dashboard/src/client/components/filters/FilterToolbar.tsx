import type { ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";

import { useDetailsPanel } from "../DetailsPanel";
import { SearchInput } from "../SearchInput";
import { Button } from "../ui/button";
import { cn } from "../../styles";

/** One filter that is set, as its removable chip shows it. */
export type ActiveFilter = {
  key: string;
  label: string;
  valueLabel: string;
};

/**
 * The search bar of a filtered page: search, the button that opens its
 * `FilterPanel`, and one removable chip per set filter. Beside an open panel
 * the chips repeat it, so they hide. `children` adds controls after the
 * button, such as a sort.
 */
export function FilterToolbar(props: {
  children?: ReactNode;
  filters?: {
    active: readonly ActiveFilter[];
    onRemove(key: string): void;
    onToggle(): void;
    open: boolean;
  };
  search: {
    label: string;
    onChange(value: string): void;
    placeholder: string;
    value: string;
  };
}) {
  const { filters } = props;
  const beside = useDetailsPanel();
  const chips =
    filters && filters.active.length > 0 && !(filters.open && beside)
      ? filters.active
      : [];
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          className="flex-1"
          label={props.search.label}
          onChange={props.search.onChange}
          placeholder={props.search.placeholder}
          size="default"
          value={props.search.value}
        />
        {filters ? (
          <Button
            aria-expanded={filters.open}
            className={cn(
              "h-11 shrink-0",
              filters.open && "bg-dashboard-surface-active",
            )}
            onClick={filters.onToggle}
          >
            <SlidersHorizontal aria-hidden="true" size={14} />
            Filters
            {filters.active.length ? (
              <span className="ml-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-dashboard-text-solid px-1.5 text-2xs font-semibold tabular-nums text-dashboard-text-inverse">
                {filters.active.length}
              </span>
            ) : null}
          </Button>
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
