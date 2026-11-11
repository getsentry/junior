import { Fragment, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";
import type { WalkthroughVersionResponse } from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { conversationPath } from "../conversations/conversationRoutes";
import { cn } from "../styles";

const linkClass =
  "rounded-sm text-dashboard-text-subtle no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus";

/**
 * One quiet line about the Walkthrough: its pull requests, the Conversation
 * that made them, and what it cost. The cost opens the generation
 * Conversation. The chapters get the attention.
 */
export function WalkthroughMeta(props: {
  /** The Conversation that made the PR, when the viewer may read it. */
  sourceConversationId?: string;
  version: WalkthroughVersionResponse;
}) {
  const { version } = props;
  const items: { key: string; node: ReactNode }[] = [
    { key: "prs", node: <PullRequests version={version} /> },
  ];
  if (props.sourceConversationId) {
    items.push({
      key: "source",
      node: (
        <span>
          Made in{" "}
          <Link
            className={linkClass}
            to={conversationPath(props.sourceConversationId)}
          >
            Conversation
          </Link>
        </span>
      ),
    });
  }
  if (version.costUsd !== undefined) {
    const cost = `$${version.costUsd.toFixed(2)}`;
    items.push({
      key: "cost",
      node: (
        <Tooltip>
          <TooltipTrigger
            render={
              // The generation Conversation holds the transcript and the
              // usage breakdown behind this number.
              version.generationConversationId ? (
                <Link
                  className={cn(linkClass, "tabular-nums")}
                  to={conversationPath(version.generationConversationId)}
                >
                  {cost}
                </Link>
              ) : (
                <span className="tabular-nums">{cost}</span>
              )
            }
          />
          <TooltipContent>
            {version.status === "generating"
              ? "What this Walkthrough has cost so far"
              : "What it cost to make this Walkthrough"}
            {version.generationConversationId
              ? ". Open the generation transcript and usage."
              : null}
          </TooltipContent>
        </Tooltip>
      ),
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
