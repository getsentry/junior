import { cn } from "../styles";

/** Share muted transcript metadata styling between segment and message chrome. */
export function mutedTranscriptMetaClass(size = "text-[0.82rem]"): string {
  return cn("leading-relaxed text-[#b8b8b8]", size);
}

/** Share the transcript empty/unavailable frame across top-level and segment views. */
export function transcriptEmptyClass(): string {
  return "border border-white/10 bg-[#050505] p-4 text-[0.9rem] leading-relaxed text-[#b8b8b8]";
}
