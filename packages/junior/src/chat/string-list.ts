/** Return stable provider lists without leaking blank or duplicate values. */
export function uniqueSortedStrings(
  values: Iterable<string | undefined>,
): string[] {
  return [
    ...new Set([...values].filter((value): value is string => !!value)),
  ].sort((left, right) => left.localeCompare(right));
}
