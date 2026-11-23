import { User, Users } from "lucide-react";

import { ScopeTabs } from "../../../components/filters/ScopeTabs";

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

/** Switch the list between Mine and All. The scope stays in the URL. */
export function AutomationScopeTabs(props: {
  scope: AutomationScope;
  search: string;
}) {
  return (
    <ScopeTabs
      label="Automations to show"
      tabs={SCOPES.map((scope) => {
        const params = new URLSearchParams(props.search);
        if (scope.key === "mine") params.delete(AUTOMATION_SCOPE_PARAM);
        else params.set(AUTOMATION_SCOPE_PARAM, scope.key);
        return {
          icon: scope.icon,
          label: scope.label,
          on: scope.key === props.scope,
          search: params.toString(),
        };
      })}
    />
  );
}
