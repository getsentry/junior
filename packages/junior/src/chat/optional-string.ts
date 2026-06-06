/**
 * Normalize optional env-style strings so blank values do not masquerade as
 * configured inputs.
 */
export function toOptionalTrimmed(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
