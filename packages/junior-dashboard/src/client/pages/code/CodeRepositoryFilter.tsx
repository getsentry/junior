import { X } from "lucide-react";
import { Link } from "react-router";

import { codeRepositorySearch } from "../../api";
import { FilterGroup } from "../../components/FilterBar";
import { Card } from "../../components/layout/Card";
import { buttonVariants } from "../../components/ui/button";
import { toggleVariants } from "../../components/ui/toggle";
import { cn } from "../../styles";

/** Show the repositories that scope `/code`, with links to remove them. */
export function CodeRepositoryFilter(props: {
  repositories: readonly string[];
}) {
  return (
    <Card padding="md">
      <FilterGroup label="Repositories">
        {props.repositories.map((repository) => (
          <Link
            aria-label={`Remove ${repository}`}
            className={cn(
              toggleVariants({ variant: "pill" }),
              "gap-1.5 font-mono no-underline",
            )}
            key={repository}
            to={{
              search: codeRepositorySearch(
                props.repositories.filter((name) => name !== repository),
              ),
            }}
          >
            {repository}
            <X aria-hidden className="size-3" />
          </Link>
        ))}
        <Link
          className={cn(buttonVariants({ variant: "ghost" }), "h-auto py-1")}
          to={{ search: "" }}
        >
          Clear
        </Link>
      </FilterGroup>
    </Card>
  );
}
