import type { JuniorPluginRegistration } from "@sentry/junior-plugin-api";

/** Configure the built-in GoCD plugin manifest and credential broker. */
export interface GoCDPluginOptions {
  /** Environment variable holding the read-only GoCD API token. */
  tokenEnv?: string;

  /**
   * Environment variable holding the GCP Workload Identity Federation audience
   * (the full `//iam.googleapis.com/projects/.../workloadIdentityPools/.../providers/...`
   * resource name) used to exchange the host's Vercel OIDC token.
   */
  wifAudienceEnv?: string;

  /** Environment variable holding the GCP service account email to impersonate for the IAP token. */
  serviceAccountEnv?: string;

  /** Environment variable holding the GoCD IAP OAuth client id (audience). Defaults to the deploy.getsentry.net client. */
  iapClientIdEnv?: string;
}

/** Register GoCD read-only manifest content and the IAP credential broker. */
export function gocdPlugin(
  options?: GoCDPluginOptions,
): JuniorPluginRegistration;
