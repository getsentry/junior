/**
 * Fail startup on the removed Google-specific option. Ignoring it would
 * leave the allowed domain list empty, which lets every Slack workspace
 * member in. `loadConfig` resolves the list and rejects the removed env var
 * the same way.
 */
export function assertNoLegacyAllowedDomains(
  dashboardOptionKeys: readonly string[],
) {
  if (dashboardOptionKeys.includes("allowedGoogleDomains")) {
    throw new Error(
      "dashboard.allowedGoogleDomains was removed; set createApp({ allowedDomains }) instead",
    );
  }
}
