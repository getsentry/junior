import type { ReactNode } from "react";

import { cn } from "../styles";
import { Card } from "./layout/Card";
import { SearchInput } from "./SearchInput";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

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
      <div className="mb-2 font-sans font-medium text-xs text-dashboard-text-muted">
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
    <Tabs onValueChange={props.onChange} value={props.value}>
      <TabsList
        aria-label={props.ariaLabel}
        className="grid grid-cols-3 sm:flex sm:overflow-x-auto"
        variant="line"
      >
        {props.items.map((item) => (
          <TabsTrigger
            className="group/tab justify-between sm:shrink-0 sm:justify-start"
            key={item.value || "all"}
            value={item.value}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="rounded-sm border border-dashboard-border bg-dashboard-fill-soft px-1.5 py-0.5 text-xs text-dashboard-text-muted group-data-active/tab:border-dashboard-accent/20 group-data-active/tab:bg-dashboard-accent/10 group-data-active/tab:text-dashboard-accent-text">
                {item.count.toLocaleString("en-US")}
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
