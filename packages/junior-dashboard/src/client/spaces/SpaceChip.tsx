import { Link } from "react-router";
import type { SpaceRefReport } from "@sentry/junior/api/schema";

import { ConversationIcon } from "../conversations/ConversationIcon";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { spacePath } from "./spaceRoutes";

/** A small link to a Conversation's Space: its icon and name. */
export function SpaceChip(props: {
  className?: string;
  space: SpaceRefReport;
}) {
  return (
    <Link
      aria-label={`Space: ${props.space.name}`}
      className={cn(
        "inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-md font-sans text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
        props.className,
      )}
      to={spacePath(props.space.id)}
    >
      <ConversationIcon name={props.space.name} size="sm" />
      <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
        {props.space.name}
      </span>
    </Link>
  );
}
