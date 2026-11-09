import { ChevronRight } from "lucide-react";
import { useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";

/**
 * Show the parents of a child Conversation as links, root first, then
 * `current`, the page title. The mobile header already shows the title, so
 * it may be left out. The agent tree labels a Thread with its invocation
 * title, so a Thread in the feed uses its own title, like the sidebar.
 */
export function ConversationBreadcrumb(props: {
  current?: ReactNode;
  /** Agent tree of the page, root first, the page itself last. */
  nodes: readonly ConversationAgentTreeNode[];
}) {
  const feedThreads = useContext(FeedThreads);
  const items = props.nodes.slice(0, -1).map((node) => ({
    conversationId: node.conversationId,
    label:
      (node.kind === "thread"
        ? feedThreads.get(node.conversationId)?.displayTitle
        : undefined) ?? node.label,
  }));
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0">
        {items.map((item, index) => (
          <li
            className="inline-flex min-w-0 shrink-[2] items-center gap-1.5"
            key={item.conversationId}
          >
            {index > 0 ? <Separator /> : null}
            <Link
              className="min-w-0 max-w-[16rem] truncate font-sans text-sm text-dashboard-text-muted no-underline underline-offset-2 hover:text-dashboard-text hover:underline"
              title={item.label}
              to={conversationPath(item.conversationId)}
            >
              {item.label}
            </Link>
          </li>
        ))}
        {props.current ? (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <Separator />
            {props.current}
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

function Separator() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="shrink-0 text-dashboard-text-faint"
      size={14}
    />
  );
}
