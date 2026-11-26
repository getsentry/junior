// The sign-in group: dashboard Google sign-in, and the domains that may use
// Junior.
import * as z from "zod";
import type { Env } from "@/config/fields";

/** Dashboard Google sign-in, and the domains that may use Junior. */
export const signInSchema = z
  .strictObject({
    /**
     * `JUNIOR_ALLOWED_DOMAINS` as set. `chat/sign-in/allowlist` parses it
     * when `createApp` resolves the allowed domains.
     */
    allowedDomains: z.string().optional(),
    /** Whether the dashboard requires sign-in when `dashboard.authRequired` is unset. */
    dashboardAuthRequired: z.boolean().default(true),
    googleClientId: z.string().optional(),
    googleClientSecret: z.string().optional(),
    /** Dashboard session secret, as given. */
    secret: z.string().optional(),
    /**
     * `JUNIOR_DASHBOARD_TRUSTED_ORIGINS` as set. Sign-in parses it when the
     * dashboard does not set `trustedOrigins`.
     */
    trustedOrigins: z.string().optional(),
  })
  .prefault({});

/** Read the sign-in group from env. */
export function readSignInEnv(env: Env) {
  // Fail on the removed name. Ignoring it would leave the domain list empty,
  // which lets every Slack workspace member in.
  if (env["JUNIOR_DASHBOARD_GOOGLE_DOMAINS"]?.trim()) {
    throw new Error(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS was removed; set JUNIOR_ALLOWED_DOMAINS instead",
    );
  }
  return {
    allowedDomains: env["JUNIOR_ALLOWED_DOMAINS"],
    dashboardAuthRequired:
      env["JUNIOR_DASHBOARD_AUTH_REQUIRED"]?.trim() !== "false",
    googleClientId: env["GOOGLE_CLIENT_ID"],
    googleClientSecret: env["GOOGLE_CLIENT_SECRET"],
    // Deliberately untrimmed, and an empty BETTER_AUTH_SECRET does not fall
    // back to JUNIOR_SECRET. Changing either would change the signing key
    // for existing sessions.
    secret: env["BETTER_AUTH_SECRET"] ?? env["JUNIOR_SECRET"],
    trustedOrigins: env["JUNIOR_DASHBOARD_TRUSTED_ORIGINS"],
  };
}
