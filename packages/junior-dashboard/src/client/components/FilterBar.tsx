import type { ReactNode } from "react";

import { cn } from "../styles";
import { Card } from "./layout/Card";
import { SearchInput } from "./SearchInput";

/** Lay out labeled filter groups and an optional search field. */
export function FilterBar(props: {
  children: ReactNode;
  className?: string;
  search?: {
    label: string;
    onChange(value: string): void;
    placeholder: string;
    value: string;
  };
}) {
  return (
    <Card className={cn("flex flex-wrap items-end gap-4 p-4", props.className)}>
      {props.children}
      {props.search ? (
        <FilterGroup className="min-w-[16rem] flex-1" label="Search">
          <SearchInput
            className="w-full max-w-md"
            label={props.search.label}
            onChange={props.search.onChange}
            placeholder={props.search.placeholder}
            value={props.search.value}
          />
        </FilterGroup>
      ) : null}
    </Card>
  );
}

/** Render one labeled control group inside a filter bar. */
export function FilterGroup(props: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div className={cn("min-w-0", props.className)}>
      <div className="mb-2 font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
        {props.label}
      </div>
      <div
        aria-label={props.label}
        className="flex flex-wrap gap-2"
        role="group"
      >
        {props.children}
      </div>
    </div>
  );
}

export type FilterTabItem = {
  count?: number;
  label: string;
  value: string;
};

/** Render collection-style filter tabs with optional counts. */
export function FilterTabList(props: {
  ariaLabel: string;
  items: readonly FilterTabItem[];
  onChange(value: string): void;
  value: string;
}) {
  return (
    <div
      aria-label={props.ariaLabel}
      className="grid min-w-0 grid-cols-3 gap-1 border-b border-white/[0.06] sm:flex sm:overflow-x-auto"
      role="tablist"
    >
      {props.items.map((item) => {
        const selected = props.value === item.value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "relative flex min-w-0 cursor-pointer items-center justify-between gap-2 border-0 bg-transparent px-3 py-2.5 font-mono text-xs uppercase tracking-[0.1em] transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-px sm:shrink-0 sm:justify-start",
              selected
                ? "text-cyan-100 after:bg-cyan-300"
                : "text-dashboard-text-muted after:bg-transparent hover:text-dashboard-text",
            )}
            key={item.value || "all"}
            onClick={() => props.onChange(item.value)}
            role="tab"
            type="button"
          >
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-xs",
                  selected
                    ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
                    : "border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted",
                )}
              >
                {item.count.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
