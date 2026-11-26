// The sandbox group: which sandbox provider runs agent commands.
import * as z from "zod";
import type { Env } from "@/config/fields";

/** The sandbox provider. */
export const sandboxSchema = z
  .strictObject({
    /** Sandbox provider for this deployment. `docker` is for local development. */
    provider: z.enum(["vercel", "docker"]).default("vercel"),
  })
  .prefault({});

/** Env var that sets each sandbox field, for error messages. */
export const sandboxEnvNames: Record<string, string> = {
  "sandbox.provider": "JUNIOR_SANDBOX_PROVIDER",
};

/** Read the sandbox group from env. */
export function readSandboxEnv(env: Env): z.input<typeof sandboxSchema> {
  return {
    provider:
      env["JUNIOR_SANDBOX_PROVIDER"]?.trim().toLowerCase() === "docker"
        ? "docker"
        : undefined,
  };
}
