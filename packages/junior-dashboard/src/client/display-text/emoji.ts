// Slack names its emoji with the iamcal dataset, so `:thinking_face:` and
// `:man-shrugging:` resolve the same way that Slack shows them.
import iamcalShortcodes from "emojibase-data/en/shortcodes/iamcal.json";

// TypeScript does not infer a type for this large JSON module.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const SHORTCODES: Readonly<Record<string, string | readonly string[]>> =
  iamcalShortcodes;

// `:name:` with an optional Slack skin tone, such as `:wave::skin-tone-3:`.
const SLACK_EMOJI_RE = /:([a-z0-9_+-]+):(?::(skin-tone-[2-6]):)?/g;

const VARIATION_SELECTOR = 0xfe0f;

function codePoints(hexcode: string): number[] {
  return hexcode.split("-").map((hex) => Number.parseInt(hex, 16));
}

const EMOJI_BY_NAME = new Map<string, number[]>();
for (const [hexcode, names] of Object.entries(SHORTCODES)) {
  const points = codePoints(hexcode);
  for (const name of typeof names === "string" ? [names] : names) {
    EMOJI_BY_NAME.set(name, points);
  }
}

function emojiText(name: string, skinTone: string | undefined): string {
  const points = EMOJI_BY_NAME.get(name);
  if (!points) return "";
  const [base, ...rest] = points;
  const tone = skinTone ? EMOJI_BY_NAME.get(skinTone)?.[0] : undefined;
  if (tone !== undefined) {
    // The tone follows the base code point and replaces its text/emoji
    // selector, as in `👋🏼` and `🤷🏼‍♂️`.
    const tail = rest[0] === VARIATION_SELECTOR ? rest.slice(1) : rest;
    return String.fromCodePoint(base!, tone, ...tail);
  }
  // A lone symbol such as `❤` shows as text unless it asks for emoji style.
  if (rest.length === 0 && base! < 0x1f000) {
    return String.fromCodePoint(base!, VARIATION_SELECTOR);
  }
  return String.fromCodePoint(...points);
}

/**
 * Replace Slack `:name:` emoji codes with the emoji. Unknown names, such as
 * custom workspace emoji, stay as text.
 */
export function replaceSlackEmoji(text: string): string {
  if (!text.includes(":")) return text;
  return text.replace(
    SLACK_EMOJI_RE,
    (match, name: string, skinTone: string | undefined) =>
      emojiText(name, skinTone) || match,
  );
}
