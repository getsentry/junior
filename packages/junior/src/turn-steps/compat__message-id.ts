// Compat: exists only so main's readers keep working; delete it once they
// read `junior_turns`. Main's readers find a person's visible message by its
// message id, and a core input's payload has none, so it comes from the
// input's inbox row.

/** The visible message id of a core Turn's input, for main's readers. */
export function compat__personMessageId(inputId: string): string {
  return `inbox:${inputId}`;
}
