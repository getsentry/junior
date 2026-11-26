// The secrets group: secrets that sign internal tokens and authenticate cron
// requests.
import * as z from "zod";
import type { Env } from "@/config/fields";

/** Secrets that sign internal tokens and authenticate cron requests. */
export const secretsSchema = z
  .strictObject({
    /** Signs internal tokens and payloads. */
    juniorSecret: z.string().optional(),
    /** Bearer secret that internal cron requests must send. */
    schedulerSecret: z.string().optional(),
  })
  .prefault({});

/** Read the secrets group from env. */
export function readSecretsEnv(env: Env) {
  return {
    juniorSecret: env["JUNIOR_SECRET"]?.trim() || undefined,
    schedulerSecret:
      env["JUNIOR_SCHEDULER_SECRET"]?.trim() || env["CRON_SECRET"]?.trim(),
  };
}
