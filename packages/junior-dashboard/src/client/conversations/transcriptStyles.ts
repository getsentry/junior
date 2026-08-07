/** Share the transcript empty/unavailable frame across top-level and segment views. */
export function transcriptEmptyClass(
  tone: "default" | "error" = "default",
): string {
  const colors =
    tone === "error"
      ? "border-rose-300/25 bg-rose-300/[0.07] text-rose-100"
      : "border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted";
  return `rounded-lg border p-5 text-sm leading-relaxed ${colors}`;
}
