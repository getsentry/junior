import { User, Users } from "lucide-react";

import { ScopeTabs } from "../../../components/filters/ScopeTabs";
import {
  CODE_SCOPE_PARAM,
  type CodeScope,
} from "../../../pages/code/codeRepositoryRoutes";

const SCOPES = [
  { icon: User, key: "mine", label: "Mine" },
  { icon: Users, key: "all", label: "All" },
] as const;

/** Switch Code between Mine and All. The scope stays in the URL. */
export function CodeScopeTabs(props: { scope: CodeScope; search: string }) {
  return (
    <ScopeTabs
      label="Code to show"
      tabs={SCOPES.map((scope) => {
        const params = new URLSearchParams(props.search);
        if (scope.key === "mine") params.delete(CODE_SCOPE_PARAM);
        else params.set(CODE_SCOPE_PARAM, scope.key);
        return {
          icon: scope.icon,
          iconOnlyOnPhone: true,
          label: scope.label,
          on: scope.key === props.scope,
          search: params.toString(),
        };
      })}
    />
  );
}
