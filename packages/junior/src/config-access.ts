// Config for who and what may reach Junior: signing secrets, dashboard
// sign-in, the allowed domains, and web push keys. `src/config.ts` composes
// it. Only `loadConfig` reads these secrets, from the env that it receives,
// so this file and `src/config.ts` show what code can touch keys (see
// `policies/security.md`). `ast-grep/rules/no-secret-env-reads.yml` blocks
// `process.env` reads of them everywhere.
import * as z from "zod";

type Env = Record<string, string | undefined>;

/** Secrets that sign internal tokens and authenticate cron requests. */
export const secretsSchema = z
  .strictObject({
    /** Signs internal tokens and payloads. */
    juniorSecret: z.string().optional(),
    /** Bearer secret that internal cron requests must send. */
    schedulerSecret: z.string().optional(),
  })
  .prefault({});

/** Dashboard Google sign-in, and the domains that may use Junior. */
export const signInSchema = z
  .strictObject({
    /**
     * Domains that may use Junior. Slack authors must have a Slack profile
     * email on one of them, and dashboard Google sign-ins must come from a
     * Google Workspace account whose `hd` claim is one of them. Slack and the
     * dashboard share one list. An empty list allows every domain.
     * `chat/identities/trust` decides who matches.
     */
    allowedDomains: z
      .array(z.string())
      .optional()
      .transform((domains = []) => [
        ...new Set(
          domains.map((value) => value.trim().toLowerCase()).filter(Boolean),
        ),
      ]),
    /** Whether the dashboard requires sign-in when `dashboard.authRequired` is unset. */
    dashboardAuthRequired: z.boolean().default(true),
    googleClientId: z.string().optional(),
    googleClientSecret: z.string().optional(),
    /** Dashboard session secret, as given. */
    secret: z.string().optional(),
    /** Trusted origins when `dashboard.trustedOrigins` is unset. */
    trustedOrigins: z.array(z.string()).optional(),
  })
  .prefault({});

/** VAPID settings for web push notifications. */
export const webPushSchema = z
  .strictObject({
    privateKey: z.string().optional(),
    publicKey: z.string().optional(),
    subject: z.string().optional(),
  })
  .prefault({});

// A list env var: a JSON string array or comma-separated values.
function parseEnvList(env: Env, name: string): string[] | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!value.startsWith("[")) return value.split(",");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array`, { cause: error });
  }
  const list = z.array(z.string()).safeParse(parsed);
  if (!list.success) throw new Error(`${name} must be a JSON string array`);
  return list.data;
}

/** Read the secrets, sign-in, and web push groups from env. */
export function readAccessEnv(env: Env) {
  // Fail on the removed name. Ignoring it would leave the domain list empty,
  // which lets every Slack workspace member in.
  if (env["JUNIOR_DASHBOARD_GOOGLE_DOMAINS"]?.trim()) {
    throw new Error(
      "JUNIOR_DASHBOARD_GOOGLE_DOMAINS was removed; set JUNIOR_ALLOWED_DOMAINS instead",
    );
  }
  return {
    secrets: {
      juniorSecret: env["JUNIOR_SECRET"]?.trim() || undefined,
      schedulerSecret:
        env["JUNIOR_SCHEDULER_SECRET"]?.trim() || env["CRON_SECRET"]?.trim(),
    },
    signIn: {
      allowedDomains: parseEnvList(env, "JUNIOR_ALLOWED_DOMAINS"),
      dashboardAuthRequired:
        env["JUNIOR_DASHBOARD_AUTH_REQUIRED"]?.trim() !== "false",
      googleClientId: env["GOOGLE_CLIENT_ID"],
      googleClientSecret: env["GOOGLE_CLIENT_SECRET"],
      // Deliberately untrimmed, and an empty BETTER_AUTH_SECRET does not fall
      // back to JUNIOR_SECRET. Changing either would change the signing key
      // for existing sessions.
      secret: env["BETTER_AUTH_SECRET"] ?? env["JUNIOR_SECRET"],
      trustedOrigins: parseEnvList(env, "JUNIOR_DASHBOARD_TRUSTED_ORIGINS"),
    },
    webPush: {
      privateKey: env["JUNIOR_WEB_PUSH_PRIVATE_KEY"]?.trim(),
      publicKey: env["JUNIOR_WEB_PUSH_PUBLIC_KEY"]?.trim(),
      subject: env["JUNIOR_WEB_PUSH_SUBJECT"]?.trim(),
    },
  };
}
