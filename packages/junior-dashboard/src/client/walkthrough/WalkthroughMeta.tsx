import { Fragment, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { WalkthroughVersionResponse } from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { conversationPath } from "../conversations/conversationRoutes";
import { conversationDetailQueryOptions } from "../conversations/queries";
import { conversationDetailTitle } from "../format";
import { cn } from "../styles";
import { WalkthroughCost } from "./WalkthroughCost";

const linkClass =
  "rounded-sm text-dashboard-text-subtle no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus";

/**
 * One quiet line about the Walkthrough: its pull requests and what it cost.
 * The cost opens its usage. The chapters get the attention.
 */
export function WalkthroughMeta(props: {
  version: WalkthroughVersionResponse;
}) {
  const { version } = props;
  const items: { key: string; node: ReactNode }[] = [
    { key: "prs", node: <PullRequests version={version} /> },
  ];
  if (version.costUsd !== undefined) {
    items.push({
      key: "cost",
      node: <WalkthroughCost className={linkClass} version={version} />,
    });
  }
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-dashboard-text-muted">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {item.node}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The Conversation where the change was made, named by its title. It shows
 * nothing until the title loads, and nothing when the viewer cannot read it.
 */
export function WalkthroughSource(props: { conversationId: string }) {
  const detail = useQuery(
    conversationDetailQueryOptions(props.conversationId),
  ).data;
  const title = conversationDetailTitle(detail);
  if (!title) return null;
  return (
    <p className="m-0 text-sm text-dashboard-text-muted">
      From:{" "}
      <Link
        className="rounded-sm break-words text-dashboard-text-subtle underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text hover:decoration-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
        to={conversationPath(props.conversationId)}
      >
        {title}
      </Link>
    </p>
  );
}

/** A lone PR is a link. A stack opens its PRs in a popover. */
function PullRequests(props: { version: WalkthroughVersionResponse }) {
  const { version } = props;
  const only =
    version.codeChanges.length === 1 ? version.codeChanges[0] : undefined;
  if (only) {
    return (
      <OutboundLink className={linkClass} href={only.url}>
        {version.repository}#{only.number}
      </OutboundLink>
    );
  }
  // Layers are stored bottom first. Read the stack top down, like GitHub.
  const changes = [...version.codeChanges].reverse();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className={cn(
              linkClass,
              "inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0",
            )}
            type="button"
          >
            {changes.length} PRs
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        aria-label="Pull requests"
        className="w-96 p-2"
      >
        {/* Every PR shows, with its whole title: the popover is already
            the "show more". */}
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {changes.map((change) => (
            <li
              className="grid gap-0.5 px-2 py-1.5 text-sm"
              key={change.number}
            >
              <OutboundLink
                className={cn(linkClass, "w-fit font-medium")}
                href={change.url}
              >
                {version.repository}#{change.number}
              </OutboundLink>
              <span className="break-words text-dashboard-text-muted">
                {change.title}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
