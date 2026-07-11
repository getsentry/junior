import type { ReactNode } from "react";

import { ToggleButton } from "./Button";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Render transcript controls without coupling them to message rendering. */
export function TranscriptHeader(props: {
  actions?: ReactNode;
  onChange(value: TranscriptViewMode): void;
  redacted: boolean;
  value: TranscriptViewMode;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-start justify-between gap-3 border-b border-[#beaaff]/20 pb-2 leading-none max-md:flex-col max-md:items-start">
      {props.redacted ? (
        <div className="min-w-0 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
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
      className="inline-flex items-center gap-1 text-[0.82rem] font-semibold text-[#888]"
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
