import { Fragment, useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "../components/ui/breadcrumb";
import { conversationPath } from "./conversationRoutes";
import { FeedThreads } from "./feedThreads";

/**
 * Show the parents of a child Conversation as links, root first, then
 * `current`, the page title. The title carries its own `aria-current`. The
 * mobile header already shows the title, so it may be left out. The agent
 * tree labels a Thread with its invocation title, so a Thread in the feed
 * uses its own title, like the sidebar.
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
    <Breadcrumb className="min-w-0">
      <BreadcrumbList>
        {items.map((item, index) => (
          <Fragment key={item.conversationId}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem className="shrink-[2]">
              <BreadcrumbLink
                className="max-w-[16rem]"
                render={<Link to={conversationPath(item.conversationId)} />}
                title={item.label}
              >
                {item.label}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        {props.current ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="text-foreground">
              {props.current}
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
