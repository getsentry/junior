import { User, Users } from "lucide-react";
import { Link } from "react-router";

import { cn } from "../../../styles";

/** The Automations the list shows: the viewer's own, or every visible one. */
export type AutomationScope = "all" | "mine";

/** The search param that holds the scope. Mine is the default. */
const AUTOMATION_SCOPE_PARAM = "scope";

/** Read the list scope from the URL. Other values show Mine. */
export function automationScopeOf(search: URLSearchParams): AutomationScope {
  return search.get(AUTOMATION_SCOPE_PARAM) === "all" ? "all" : "mine";
}

const SCOPES = [
  { icon: User, key: "mine", label: "Mine" },
  { icon: Users, key: "all", label: "All" },
] as const;

/**
 * Switch the list between Mine and All, as one segmented control in the
 * style of the old Inbox / Automations tabs. Each tab is a link, so the
 * scope stays in the URL with the other filters.
 */
export function AutomationScopeTabs(props: {
  scope: AutomationScope;
  search: string;
}) {
  return (
    <nav
      aria-label="Automations to show"
      className="flex min-w-0 gap-0.5 rounded-xl bg-dashboard-fill-soft p-0.5"
    >
      {SCOPES.map((scope) => {
        const Icon = scope.icon;
        const on = scope.key === props.scope;
        const params = new URLSearchParams(props.search);
        if (scope.key === "mine") params.delete(AUTOMATION_SCOPE_PARAM);
        else params.set(AUTOMATION_SCOPE_PARAM, scope.key);
        return (
          <Link
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-[0.625rem] px-3 font-sans text-xs font-medium no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
              on
                ? "bg-dashboard-surface-raised text-dashboard-text shadow-sm ring-1 ring-dashboard-border"
                : "text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
            )}
            key={scope.key}
            replace
            to={{ search: params.toString() }}
          >
            <Icon
              aria-hidden="true"
              className="size-4 shrink-0"
              strokeWidth={1.9}
            />
            {scope.label}
          </Link>
        );
      })}
    </nav>
  );
}
