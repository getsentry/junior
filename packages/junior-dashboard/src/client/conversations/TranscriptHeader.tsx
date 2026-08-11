import type { ReactNode } from "react";

import { ToggleButton } from "../components/Button";
import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";
import type { TranscriptViewMode } from "./transcriptRenderModel";

const TRANSCRIPT_VIEW_OPTIONS: Array<{
  label: string;
  value: TranscriptViewMode;
}> = [
  { label: "Conversation", value: "rich" },
  { label: "Event log", value: "raw" },
];

/** Render one compact transcript toolbar: search, view mode, and actions. */
export function TranscriptHeader(props: {
  actions?: ReactNode;
  onChange(value: TranscriptViewMode): void;
  onSearchChange(value: string): void;
  redacted: boolean;
  search: string;
  value: TranscriptViewMode;
}) {
  return (
    <div className="mb-3 grid min-w-0 gap-2 md:mb-4">
      {props.redacted ? (
        <div className="min-w-0 break-words text-sm leading-relaxed text-dashboard-text-muted">
          Hidden because this conversation is not public.
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput
          className="min-w-0 flex-1"
          label="Search transcript"
          onChange={props.onSearchChange}
          placeholder="Search transcript…"
          size="compact"
          value={props.search}
        />
        <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
          <TranscriptViewToggle value={props.value} onChange={props.onChange} />
          {props.actions}
        </div>
      </div>
    </div>
  );
}

function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <div
      aria-label="Transcript view"
      className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-black/20 p-0.5 text-xs font-medium text-dashboard-text-muted"
      role="group"
    >
      {TRANSCRIPT_VIEW_OPTIONS.map((option) => (
        <ToggleButton
          className={cn(
            "!normal-case rounded-md px-2 py-1 font-sans text-xs font-medium tracking-normal no-underline",
            props.value === option.value &&
              "bg-white/[0.08] text-dashboard-text",
          )}
          key={option.value}
          onClick={() => props.onChange(option.value)}
          pressed={props.value === option.value}
          variant="text"
        >
          {option.label}
        </ToggleButton>
      ))}
    </div>
  );
}
