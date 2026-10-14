import { Bot, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { conversationPath } from "./conversationRoutes";

/**
 * Show the parents of a child Conversation, root first. The page title already
 * names this agent, so the last node is not shown. Root Conversations have no
 * tree.
 */
export function ConversationAgentTree(props: {
  nodes: readonly ConversationAgentTreeNode[];
}) {
  return (
    <nav
      aria-label="Agent tree"
      className="flex min-w-0 items-center gap-1.5 text-xs leading-snug text-dashboard-text-muted"
    >
      <Bot aria-hidden="true" className="shrink-0 text-cyan-300" size={12} />
      <ol className="m-0 flex min-w-0 list-none items-center gap-1 p-0">
        {props.nodes.slice(0, -1).map((node, index) => (
          <li
            className="inline-flex min-w-0 items-center gap-1"
            key={node.conversationId}
          >
            {index > 0 ? (
              <ChevronRight aria-hidden="true" className="shrink-0" size={12} />
            ) : null}
            <Link
              className="min-w-0 max-w-[16rem] truncate font-medium text-dashboard-text no-underline underline-offset-2 hover:underline"
              title={node.label}
              to={conversationPath(node.conversationId)}
            >
              {node.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
