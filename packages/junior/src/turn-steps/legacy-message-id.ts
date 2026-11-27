// LEGACY COMPAT: main's readers find a person's visible message by its
// message id. A core Turn's input payload has no provider message id, so the
// id comes from the input's inbox row. Delete this with the other legacy Turn
// rows once readers read `junior_turns`.

/** The visible message id of a core Turn's input, for main's readers. */
export function legacyInputMessageId(inputId: string): string {
  return `inbox:${inputId}`;
}
