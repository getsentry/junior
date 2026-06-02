import { ToggleButton } from "./Button";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Render transcript controls without coupling them to turn rendering. */
export function TranscriptHeader(props: {
  onChange(value: TranscriptViewMode): void;
  redacted: boolean;
  value: TranscriptViewMode;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-start justify-between gap-3 border-b border-[#beaaff]/20 pb-3 leading-none max-md:flex-col">
      <div className="min-w-0">
        <div className="text-[0.78rem] font-semibold uppercase text-[#888]">
          Transcript
        </div>
        {props.redacted ? (
          <div className="mt-2 break-words text-[0.88rem] leading-relaxed text-[#b8b8b8]">
            Hidden because this conversation is not public.
          </div>
        ) : null}
      </div>
      <TranscriptViewToggle value={props.value} onChange={props.onChange} />
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
