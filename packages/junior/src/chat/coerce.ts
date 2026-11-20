/** Narrow an unknown value to a non-empty string, or undefined. */
export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Narrow an unknown value to a finite number, or undefined. */
export function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
