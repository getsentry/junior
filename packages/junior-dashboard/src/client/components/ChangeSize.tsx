import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { codeChangeSize } from "../codeChangeSize";
import type { ListedObject } from "../display-text/DisplayText";
import { listedChangeSize } from "../listedCodeChange";
import {
  CLOSED_TONE_CLASS,
  OPEN_TONE_CLASS,
} from "../conversations/ConversationMeta";
import { cn } from "../styles";

/**
 * A code change's size, such as `+1.2k −340 · 12 files`, in small muted
 * text unless `className` sets the type, with the line counts in green
 * and red. The tooltip and the accessible
 * name give the exact counts. Renders nothing when no part is known.
 */
export function ChangeSize(props: {
  className?: string;
  size: CodeChangeSize | undefined;
}) {
  const size = codeChangeSize(props.size);
  if (!size) return null;
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap font-sans font-normal tabular-nums",
        props.className ?? "text-xs text-dashboard-text-muted",
      )}
      data-code-change-size=""
      title={size.label}
    >
      <span aria-hidden>
        {/* Added lines are green and removed lines red, as GitHub shows them. */}
        {size.added ? (
          <span className={OPEN_TONE_CLASS}>{size.added}</span>
        ) : null}
        {size.added && size.removed ? " " : null}
        {size.removed ? (
          <span className={CLOSED_TONE_CLASS}>{size.removed}</span>
        ) : null}
        {(size.added || size.removed) && size.files ? " · " : null}
        {size.files}
      </span>
      <span className="sr-only">{size.label}</span>
    </span>
  );
}

/**
 * The live size of a code change in a list: a placeholder until its card
 * comes, then its size, or nothing when the card has none.
 */
export function ListedChangeSize(props: {
  className?: string;
  listed: ListedObject;
}) {
  if (!props.listed.settled) {
    // A span, as the skeleton's div cannot sit in a line of text.
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-3 w-16 animate-pulse rounded-md bg-dashboard-fill-soft align-middle motion-reduce:animate-none",
          props.className,
        )}
        data-code-change-size-pending=""
      />
    );
  }
  return (
    <ChangeSize
      className={props.className}
      size={listedChangeSize(props.listed)}
    />
  );
}
