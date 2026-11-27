// Names often share a leading word, such as "Junior Evals" and "Junior
// Infra". The icon must still tell them apart, so its glyph takes the last
// word's initial too, and its color comes from an ID, not the name.

// Tinted fills with text of the same hue. The 800 text in light mode and the
// 300 text in dark mode keep at least 4.5:1 contrast on the tint over every
// pane and row background.
const ICON_COLORS = [
  "bg-rose-500/20 text-rose-800 dark:text-rose-300",
  "bg-orange-500/20 text-orange-800 dark:text-orange-300",
  "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  "bg-lime-500/20 text-lime-800 dark:text-lime-300",
  "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300",
  "bg-teal-500/20 text-teal-800 dark:text-teal-300",
  "bg-cyan-500/20 text-cyan-800 dark:text-cyan-300",
  "bg-blue-500/20 text-blue-800 dark:text-blue-300",
  "bg-indigo-500/20 text-indigo-800 dark:text-indigo-300",
  "bg-violet-500/20 text-violet-800 dark:text-violet-300",
  "bg-fuchsia-500/20 text-fuchsia-800 dark:text-fuchsia-300",
  "bg-pink-500/20 text-pink-800 dark:text-pink-300",
] as const;

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

/** The icon's color classes. An ID gets the same color on every surface. */
export function conversationIconColor(iconId: string): string {
  // 32-bit FNV-1a spreads similar IDs over the whole palette.
  let hash = 0x811c9dc5;
  for (let index = 0; index < iconId.length; index += 1) {
    hash = Math.imul(hash ^ iconId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return ICON_COLORS[hash % ICON_COLORS.length]!;
}

/**
 * The ID that picks a Conversation's icon color: its own ID, or for a Lead,
 * its Space's ID. Space icons used the Space ID before every Conversation
 * had an icon, so a Space and its Lead keep that color.
 */
export function conversationIconId(conversation: {
  conversationId: string;
  kind: string;
  space?: { id: string } | null | undefined;
}): string {
  return conversation.kind === "lead" && conversation.space
    ? conversation.space.id
    : conversation.conversationId;
}
