import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { ChevronRight, FolderTree } from "lucide-react";
import { Link } from "react-router";

import { spacePath } from "../pages/spaces/spaceRoutes";

/** Link a conversation back to its Space, with the full Space path. */
export function ConversationSpaceLink(props: {
  space: NonNullable<ConversationDetailReport["space"]>;
}) {
  return (
    <nav
      aria-label="Space"
      className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs text-dashboard-text-muted"
    >
      <FolderTree aria-hidden="true" className="size-3 shrink-0" />
      {props.space.path.map((crumb, index) => (
        <span className="flex min-w-0 items-center gap-1" key={crumb.spaceId}>
          {index > 0 ? (
            <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <Link
            className="truncate text-inherit no-underline hover:text-cyan-100"
            to={spacePath(crumb.spaceId)}
          >
            {crumb.name}
          </Link>
        </span>
      ))}
    </nav>
  );
}
