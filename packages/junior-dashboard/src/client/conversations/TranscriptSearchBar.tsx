import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { SearchInput } from "../components/SearchInput";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import type { TranscriptSearchMatch } from "./transcriptSearch";

/**
 * Float transcript search over the transcript, below the positioned header
 * that holds it, so opening search does not move the conversation. The
 * arrows, Enter, and Shift+Enter step through the matches. Escape closes it.
 */
export function TranscriptSearchBar(props: {
  /** Horizontal placement and width inside the header. */
  className: string;
  inputRef: RefObject<HTMLInputElement | null>;
  match: TranscriptSearchMatch;
  onChange(value: string): void;
  onClose(): void;
  value: string;
}) {
  return (
    <div
      className={cn(
        "absolute top-full z-20 mt-2 flex items-center gap-2 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-1.5 shadow-lg",
        props.className,
      )}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          props.match.step(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key !== "Escape") return;
        // Close only the search, not the drawer or details panel around it.
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <SearchInput
        className="min-w-0 flex-1"
        inputRef={props.inputRef}
        label="Search transcript"
        onChange={props.onChange}
        placeholder="Search transcript…"
        size="compact"
        value={props.value}
      />
      {props.value.trim() ? (
        <span
          aria-live="polite"
          className="shrink-0 pr-1.5 text-xs tabular-nums text-dashboard-text-muted"
        >
          {props.match.count === 0
            ? "0/0"
            : `${props.match.index + 1}/${props.match.count}`}
        </span>
      ) : null}
      <StepButton
        disabled={props.match.count === 0}
        label="Previous match"
        onClick={() => props.match.step(-1)}
      >
        <ChevronUp aria-hidden="true" size={14} strokeWidth={2} />
      </StepButton>
      <StepButton
        disabled={props.match.count === 0}
        label="Next match"
        onClick={() => props.match.step(1)}
      >
        <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
      </StepButton>
      <Button
        aria-label="Close search"
        onClick={props.onClose}
        className="size-7"
        size="icon"
        variant="ghost"
      >
        <X aria-hidden="true" size={14} strokeWidth={2} />
      </Button>
    </div>
  );
}

function StepButton(props: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      aria-label={props.label}
      className="size-7"
      disabled={props.disabled}
      onClick={props.onClick}
      // Keep focus in the search box, so typing and Enter still work.
      onMouseDown={(event) => event.preventDefault()}
      size="icon"
      title={props.label}
      variant="ghost"
    >
      {props.children}
    </Button>
  );
}
