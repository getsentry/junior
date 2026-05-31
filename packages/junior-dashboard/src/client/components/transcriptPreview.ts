/** Summarize a transcript payload value for closed tool/details headers. */
export function previewToolValue(value: unknown): string {
  if (!isPreviewableValue(value)) return "no arguments";
  const source =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nested) =>
          typeof nested === "string" && nested.length > 80
            ? `${nested.slice(0, 77)}...`
            : nested,
        );
  return source.length > 120 ? `${source.slice(0, 117)}...` : source;
}

/** Decide whether a transcript payload has useful preview text. */
export function isPreviewableValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}
