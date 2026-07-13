import { cn } from "../styles";

/** Share muted transcript metadata styling between segment and message chrome. */
export function mutedTranscriptMetaClass(size = "text-[0.82rem]"): string {
  return cn("leading-relaxed text-white/45", size);
}

/** Share the transcript empty/unavailable frame across top-level and segment views. */
export function transcriptEmptyClass(): string {
  return "rounded-lg border border-white/[0.07] bg-white/[0.025] p-5 text-[0.88rem] leading-relaxed text-white/45";
}
