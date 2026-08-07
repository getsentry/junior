import type { ReactNode } from "react";

import { ToggleButton } from "../components/Button";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Render transcript controls without coupling them to message rendering. */
export function TranscriptHeader(props: {
  actions?: ReactNode;
  onChange(value: TranscriptViewMode): void;
  redacted: boolean;
  value: TranscriptViewMode;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-center justify-between gap-3 leading-none max-md:flex-col max-md:items-start">
      {props.redacted ? (
        <div className="min-w-0 break-words text-sm leading-relaxed text-dashboard-text-muted">
          Hidden because this conversation is not public.
        </div>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0">
        <TranscriptViewToggle value={props.value} onChange={props.onChange} />
        {props.actions}
      </div>
    </div>
  );
}

function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  const options: TranscriptViewMode[] = ["rich", "raw"];
  return (
    <div
      aria-label="Transcript view"
      className="inline-flex items-center gap-1 rounded-lg border border-white/[0.07] bg-black/20 p-1 text-xs font-semibold text-dashboard-text-muted"
      role="group"
    >
      {options.map((option) => (
        <ToggleButton
          key={option}
          onClick={() => props.onChange(option)}
          pressed={props.value === option}
          variant="text"
        >
          {option}
        </ToggleButton>
      ))}
    </div>
  );
}
