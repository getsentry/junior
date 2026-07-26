/** Remove the explicit Slack steering marker before building agent input. */
export function stripLeadingSteeringOverride(text: string): string {
  return text.replace(/^\s*!!\s*/, "");
}
