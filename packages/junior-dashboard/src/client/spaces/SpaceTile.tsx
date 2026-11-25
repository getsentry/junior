import { Link } from "react-router";
import type { SpaceRefReport } from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { spacePath } from "./spaceRoutes";

// Tinted fills with text of the same hue read in both themes.
const TILE_COLORS = [
  "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  "bg-teal-500/20 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/20 text-indigo-700 dark:text-indigo-300",
  "bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300",
] as const;

const TILE_SIZES = {
  // The pane's icon column.
  sm: "size-4 rounded text-2xs",
  md: "size-5 rounded-md text-xs",
  lg: "size-10 rounded-lg text-lg",
} as const;

/** The same Space gets the same color on every surface. */
function tileColor(spaceId: string): string {
  let hash = 0;
  for (const char of spaceId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

/** A Space's colored tile with the first letter of its name. */
export function SpaceTile(props: {
  className?: string;
  size: keyof typeof TILE_SIZES;
  space: SpaceRefReport;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center font-sans font-semibold leading-none select-none",
        TILE_SIZES[props.size],
        tileColor(props.space.id),
        props.className,
      )}
    >
      {props.space.name.trim().charAt(0).toUpperCase()}
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
