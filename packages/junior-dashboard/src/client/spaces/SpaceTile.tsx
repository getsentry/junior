import { LockKeyhole } from "lucide-react";
import { Link } from "react-router";
import type {
  SpaceRefReport,
  SpaceVisibilityReport,
} from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { spacePath } from "./spaceRoutes";
import { spaceInitials, spaceTileColor } from "./spaceTileMark";

const TILE_SIZES = {
  // The pane's icon column.
  sm: "size-4 rounded",
  md: "size-5 rounded-md",
  lg: "size-10 rounded-lg",
} as const;

// Two letters take a smaller size than one, so they fit the tile.
const GLYPH_SIZES = {
  sm: { one: "text-2xs", two: "text-3xs tracking-tighter" },
  md: { one: "text-xs", two: "text-2xs tracking-tighter" },
  lg: { one: "text-lg", two: "text-base" },
} as const;

// The lock sits on the bottom-right corner. The top-right corner and the
// row's trailing column stay free for activity and needs-you marks.
// Important, so that a parent's `[&_svg]:size-*`, such as a command item's,
// does not grow the lock over the tile.
const LOCK_SIZES = {
  sm: "!size-2.5 p-px",
  md: "!size-3 p-0.5",
  lg: "!size-4 p-0.5",
} as const;

/**
 * A Space's colored tile with the initials of its name, and a lock on its
 * corner when the Space is private.
 */
export function SpaceTile(props: {
  className?: string;
  size: keyof typeof TILE_SIZES;
  space: SpaceRefReport & { visibility?: SpaceVisibilityReport };
}) {
  const initials = spaceInitials(props.space.name);
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center font-sans font-semibold leading-none select-none",
        TILE_SIZES[props.size],
        GLYPH_SIZES[props.size][
          Array.from(initials).length > 1 ? "two" : "one"
        ],
        spaceTileColor(props.space.id),
        props.className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
      {props.space.visibility === "private" ? (
        <LockKeyhole
          aria-label="Private Space"
          className={cn(
            "absolute -right-1 -bottom-1 rounded-full bg-dashboard-bg text-dashboard-text-muted",
            LOCK_SIZES[props.size],
          )}
          role="img"
          strokeWidth={2.5}
        />
      ) : null}
    </span>
  );
}

/** A small link to a Conversation's Space: its tile and name. */
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
      <SpaceTile size="sm" space={props.space} />
      <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
        {props.space.name}
      </span>
    </Link>
  );
}
