import { LockKeyhole } from "lucide-react";

import { cn } from "../styles";
import { conversationInitials } from "./conversationIconMark";

// The Product style (`brand/styles.md`): a solid fill in the text color with
// the inverse text color for the glyph, so it keeps more than 15:1 contrast
// in both themes and needs no other decoration. Change the icon's look here.
const ICON_STYLE = "bg-dashboard-text text-dashboard-text-inverse";

const ICON_SIZES = {
  // The pane's icon column.
  sm: "size-4 rounded",
  md: "size-5 rounded-md",
} as const;

// Two letters take a smaller size than one, so they fit the icon.
const GLYPH_SIZES = {
  sm: { one: "text-2xs", two: "text-3xs tracking-tighter" },
  md: { one: "text-xs", two: "text-2xs tracking-tighter" },
} as const;

// The lock sits on the bottom-right corner. The top-right corner and the
// row's trailing column stay free for activity and needs-you marks.
// Important, so that a parent's `[&_svg]:size-*`, such as a command item's,
// does not grow the lock over the icon.
const LOCK_SIZES = {
  sm: "!size-2.5 p-px",
  md: "!size-3 p-0.5",
} as const;

/**
 * A Conversation's colored icon with the initials of its name, and a lock on
 * its corner when it is private. A Space shows its Lead's icon.
 */
export function ConversationIcon(props: {
  className?: string;
  name: string;
  /** Set only on Space surfaces, where nothing else shows the visibility. */
  visibility?: "private" | "public" | undefined;
  size: keyof typeof ICON_SIZES;
}) {
  const initials = conversationInitials(props.name);
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center font-sans font-semibold leading-none select-none",
        ICON_SIZES[props.size],
        GLYPH_SIZES[props.size][
          Array.from(initials).length > 1 ? "two" : "one"
        ],
        ICON_STYLE,
        props.className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
      {props.visibility === "private" ? (
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
