// Names often share a leading word, such as "Junior Evals" and "Junior
// Infra". The icon must still tell them apart, so its glyph takes the last
// word's initial too.

// Words split on spaces and on the separators that names use in place of
// them, such as "junior-evals" or "sdk/python".
const WORD_SEPARATOR = /[\s\-_/.:]+/u;
const FIRST_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The icon's glyph: the initials of the first and last words of the name,
 * such as "JE" for "Junior Evals", or one initial for a one-word name.
 */
export function conversationInitials(name: string): string {
  const initials = name
    .split(WORD_SEPARATOR)
    .flatMap((word) => word.match(FIRST_LETTER_OR_DIGIT) ?? []);
  const first = initials[0];
  // A name with no letter or digit, such as an emoji, shows its first
  // character.
  if (!first) return Array.from(name.trim())[0] ?? "";
  const last = initials.length > 1 ? initials[initials.length - 1] : "";
  return `${first}${last}`.toUpperCase();
}
