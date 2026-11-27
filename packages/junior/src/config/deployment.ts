// The deployment group: the public base URL, the Vercel deployment, and
// install-wide defaults such as the timezone and the Sentry org.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

const DEFAULT_TIMEZONE = "America/Los_Angeles";

/** The public base URL and the Vercel deployment that runs this process. */
export const deploymentSchema = z
  .strictObject({
    /** Public base URL that the host sets: `dashboard.baseURL` or `JUNIOR_BASE_URL`. */
    configuredBaseUrl: z.string().optional(),
    /** Git commit of this deployment. */
    commitSha: z.string().optional(),
    /** Vercel deployment that runs this process. Unset outside Vercel. */
    id: z.string().optional(),
    /** Vercel hostnames, for the base URL when none is configured. */
    vercelProductionUrl: z.string().optional(),
    vercelUrl: z.string().optional(),
    /** Timezone for people whose timezone Junior does not know. */
    timezone: z.string().default(DEFAULT_TIMEZONE),
    /** Sentry org slug for links to Sentry. */
    sentryOrgSlug: z.string().optional(),
  })
  .prefault({});

// A Vercel deployment hostname has no scheme.
function withHttps(host: string): string {
  return host.startsWith("https://") || host.startsWith("http://")
    ? host
    : `https://${host}`;
}

/** Read the deployment group from env. */
export function readDeploymentEnv(env: Env) {
  return {
    configuredBaseUrl: toOptionalTrimmed(env["JUNIOR_BASE_URL"]),
    commitSha: toOptionalTrimmed(env["VERCEL_GIT_COMMIT_SHA"]),
    id: toOptionalTrimmed(env["VERCEL_DEPLOYMENT_ID"]),
    vercelProductionUrl: toOptionalTrimmed(
      env["VERCEL_PROJECT_PRODUCTION_URL"],
    ),
    vercelUrl: toOptionalTrimmed(env["VERCEL_URL"]),
    timezone: toOptionalTrimmed(env["JUNIOR_TIMEZONE"]),
    sentryOrgSlug: toOptionalTrimmed(env["SENTRY_ORG_SLUG"]),
  };
}

/** Resolve the public base URL: the configured one, else the Vercel URL. */
export function deriveDeployment(
  deployment: z.output<typeof deploymentSchema>,
) {
  const vercelUrl = deployment.vercelProductionUrl ?? deployment.vercelUrl;
  return {
    /** Public base URL: the configured one, else the Vercel URL. */
    baseUrl:
      deployment.configuredBaseUrl ??
      (vercelUrl ? withHttps(vercelUrl) : undefined),
    configuredBaseUrl: deployment.configuredBaseUrl,
    commitSha: deployment.commitSha,
    id: deployment.id,
    timezone: deployment.timezone,
    sentryOrgSlug: deployment.sentryOrgSlug,
  };
}
