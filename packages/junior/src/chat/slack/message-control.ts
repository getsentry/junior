/** Leading Slack mention forms that may precede an explicit steering marker. */
const LEADING_MENTION_BEFORE_STEERING_RE =
  /^(\s*(?:<@[^>]+>|@[A-Za-z0-9._-]+\b)[\s,:-]*)!!\s*/;

/** Remove the explicit Slack steering marker before building agent input. */
export function stripLeadingSteeringOverride(text: string): string {
  // Message.text is usually plain text from the Slack adapter, so mentions may
  // already be `@U123` / `@name` rather than raw `<@U123>` tokens.
  return text
    .replace(LEADING_MENTION_BEFORE_STEERING_RE, "$1")
    .replace(/^\s*!!\s*/, "");
}
