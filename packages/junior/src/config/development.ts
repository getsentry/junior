// The development group: settings of a local development run.
import * as z from "zod";
import type { Env } from "@/config/fields";

/** Settings of a local development run. */
export const developmentSchema = z
  .strictObject({
    /** True when `NODE_ENV` is `development`, such as under `pnpm dev`. */
    enabled: z.boolean().default(false),
    /** Port of the local dev server, for the CLI to reach it. */
    port: z.string().default("3000"),
  })
  .prefault({});

/** Read the development group from env. */
export function readDevelopmentEnv(
  env: Env,
): z.input<typeof developmentSchema> {
  return {
    enabled: env["NODE_ENV"] === "development",
    port: env["PORT"]?.trim() || undefined,
  };
}
