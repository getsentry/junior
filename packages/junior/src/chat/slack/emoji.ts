const SLACK_EMOJI_NAME_RE = /^(?:[a-z0-9_+-]+)(?:::(?:skin-tone-[2-6]))?$/;

export function normalizeSlackEmojiName(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const normalized =
    trimmed.startsWith(":") && trimmed.endsWith(":")
      ? trimmed.slice(1, -1)
      : trimmed;

  return SLACK_EMOJI_NAME_RE.test(normalized) ? normalized : null;
}
