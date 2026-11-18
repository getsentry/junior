import type { ReactNode } from "react";

import { cn } from "../styles";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

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
            className="justify-between sm:shrink-0 sm:justify-start"
            key={item.value || "all"}
            value={item.value}
          >
            {item.label}
            {item.count !== undefined ? (
              <Badge
                className="py-0.5"
                variant={item.value === props.value ? "accent" : "muted"}
              >
                {item.count.toLocaleString("en-US")}
              </Badge>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
