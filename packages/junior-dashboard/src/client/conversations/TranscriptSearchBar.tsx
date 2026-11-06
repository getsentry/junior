import type { RefObject } from "react";

import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";

/**
 * Float transcript search over the transcript, below the positioned header
 * that holds it, so opening search does not move the conversation. Escape
 * closes it.
 */
export function TranscriptSearchBar(props: {
  /** Horizontal placement and width inside the header. */
  className: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange(value: string): void;
  onClose(): void;
  value: string;
}) {
  return (
    <div
      className={cn(
        "absolute top-full z-20 mt-2 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-1.5 shadow-lg",
        props.className,
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Close only the search, not the drawer or details panel around it.
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <SearchInput
        className="min-w-0"
        inputRef={props.inputRef}
        label="Search transcript"
        onChange={props.onChange}
        placeholder="Search transcript…"
        size="compact"
        value={props.value}
      />
    </div>
  );
}
