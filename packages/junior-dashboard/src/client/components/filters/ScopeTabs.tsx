import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";

import { cn, dashboardCountClass } from "../../styles";

/** One tab: what it shows, and the search that the list has when it is on. */
export type ScopeTab = {
  count?: number;
  icon?: LucideIcon;
  /** On a phone the tab shows only its icon, so the tabs fit one row. */
  iconOnlyOnPhone?: boolean;
  label: string;
  on: boolean;
  search: string;
};

/**
 * Pick what a list shows, as one segmented control in the style of the old
 * Inbox / Automations tabs. Each tab is a link, so the choice stays in the
 * URL with the other filters. One tab alone is a toggle.
 */
export function ScopeTabs(props: { label: string; tabs: readonly ScopeTab[] }) {
  return (
    <nav
      aria-label={props.label}
      className="flex min-w-0 gap-0.5 rounded-lg bg-dashboard-fill-soft p-0.5"
    >
      {props.tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link
            aria-current={tab.on ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 font-sans max-md:px-1.5 text-xs font-medium whitespace-nowrap no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
              tab.on
                ? "bg-dashboard-surface-active text-dashboard-text"
                : "text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
            )}
            key={tab.label}
            replace
            to={{ search: tab.search }}
          >
            {Icon ? (
              <Icon
                aria-hidden="true"
                className="size-4 shrink-0"
                strokeWidth={1.9}
              />
            ) : null}
            <span
              className={
                Icon && tab.iconOnlyOnPhone ? "max-md:sr-only" : undefined
              }
            >
              {tab.label}
            </span>
            {tab.count === undefined ? null : (
              <span className={dashboardCountClass}>{tab.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
