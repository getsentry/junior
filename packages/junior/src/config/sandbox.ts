// The sandbox group: which sandbox provider runs agent commands, its size and
// keepalive, provider settings, and snapshot freshness.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { optionCheck, type Env } from "@/config/fields";

const DEFAULT_SNAPSHOT_FLOATING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The sandbox provider and its settings. */
export const sandboxSchema = z
  .strictObject({
    /** Sandbox provider for this deployment. `docker` is for local development. */
    provider: z.enum(["vercel", "docker"]).default("vercel"),
    /**
     * vCPUs of each sandbox. A Workspace vCPU count wins over it. Env only
     * sets valid values, so the check reaches only `createApp({ sandbox })`.
     */
    vcpus: z
      .custom<number>(
        (value) => Number.isSafeInteger(value) && Number(value) > 0,
        optionCheck("sandbox.vcpus must be a positive integer"),
      )
      .optional(),
    /** Sandbox keepalive in ms. 0 turns it off. */
    keepAliveMs: z.number().default(0),
    /** Settings of the local Docker provider. */
    docker: z
      .strictObject({
        /** `DOCKER_HOST`. The provider accepts only `unix://` sockets. */
        host: z.string().optional(),
        /** Directory for machine-wide provider files, such as the egress CA key. */
        dir: z.string().optional(),
        /** PEM file with more CA certificates for each sandbox to trust. */
        extraCaCertsFile: z.string().optional(),
      })
      .prefault({}),
    /**
     * Explicit Vercel Sandbox credentials. Junior uses them only when all
     * three are set; otherwise the SDK reads ambient Vercel auth.
     */
    vercel: z
      .strictObject({
        token: z.string().optional(),
        teamId: z.string().optional(),
        projectId: z.string().optional(),
      })
      .prefault({}),
    snapshot: z
      .strictObject({
        /** Age in ms after which a snapshot with floating inputs is rebuilt. */
        floatingMaxAgeMs: z
          .number()
          .default(DEFAULT_SNAPSHOT_FLOATING_MAX_AGE_MS),
        /** Changing this value rebuilds every snapshot. */
        rebuildEpoch: z.string().default(""),
      })
      .prefault({}),
  })
  .prefault({});

/** Env var that sets each sandbox field, for error messages. */
export const sandboxEnvNames: Record<string, string> = {
  "sandbox.provider": "JUNIOR_SANDBOX_PROVIDER",
};

// An invalid value counts as unset. Only the createApp option is checked.
function parseVcpus(rawValue: string | undefined): number | undefined {
  const value = rawValue?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const vcpus = Number(value);
  return Number.isSafeInteger(vcpus) && vcpus > 0 ? vcpus : undefined;
}

function parseKeepAliveMs(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Unset, blank, negative, or invalid values use the default. 0 is allowed.
function parseFloatingMaxAgeMs(rawValue: string | undefined): number {
  if (!rawValue?.trim()) {
    return DEFAULT_SNAPSHOT_FLOATING_MAX_AGE_MS;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SNAPSHOT_FLOATING_MAX_AGE_MS;
}

/** Read the sandbox group from env. */
export function readSandboxEnv(env: Env): z.input<typeof sandboxSchema> {
  return {
    provider:
      env["JUNIOR_SANDBOX_PROVIDER"]?.trim().toLowerCase() === "docker"
        ? "docker"
        : undefined,
    vcpus: parseVcpus(env["SANDBOX_VCPUS"]),
    keepAliveMs: parseKeepAliveMs(env["VERCEL_SANDBOX_KEEPALIVE_MS"]),
    docker: {
      host: env["DOCKER_HOST"]?.trim() || undefined,
      dir: env["JUNIOR_DOCKER_SANDBOX_DIR"]?.trim() || undefined,
      extraCaCertsFile:
        env["JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS"]?.trim() || undefined,
    },
    vercel: {
      token: toOptionalTrimmed(env["VERCEL_TOKEN"]),
      teamId: toOptionalTrimmed(env["VERCEL_TEAM_ID"]),
      projectId: toOptionalTrimmed(env["VERCEL_PROJECT_ID"]),
    },
    snapshot: {
      floatingMaxAgeMs: parseFloatingMaxAgeMs(
        env["SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS"],
      ),
      rebuildEpoch: env["SANDBOX_SNAPSHOT_REBUILD_EPOCH"]?.trim() ?? "",
    },
  };
}
