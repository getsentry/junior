import os from "node:os";
import path from "node:path";

// Module overview: local settings of the Docker sandbox provider. They come
// from env vars, so the provider needs no new chat config fields.

/** Label on every container, network, and image that this provider owns. */
export const DOCKER_SANDBOX_LABEL = "dev.junior.sandbox";

/**
 * Directory for machine-wide provider files, such as the egress CA key.
 * `JUNIOR_DOCKER_SANDBOX_DIR` overrides the default.
 */
export function dockerSandboxDir(): string {
  const configured = process.env.JUNIOR_DOCKER_SANDBOX_DIR?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".cache", "junior", "docker-sandbox");
}

/**
 * Optional PEM file with more CA certificates for each sandbox to trust.
 *
 * Use this when the Docker host itself sits behind a TLS proxy, such as the
 * network proxy of a Vercel Sandbox. Without it, sandbox containers cannot
 * verify the certificates that this proxy shows.
 */
export function dockerSandboxExtraCaFile(): string | undefined {
  return process.env.JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS?.trim() || undefined;
}

/**
 * Optional list of runtime dependency packages that snapshots install.
 *
 * `JUNIOR_DOCKER_SANDBOX_RUNTIME_DEPENDENCIES` is a comma-separated list of
 * declared package names, such as `gh,jq,ripgrep`. When it is set, snapshots
 * install only those packages and run no postinstall commands. The agent
 * installs other tools when it needs them. When it is unset, snapshots install
 * every declared dependency.
 */
export function dockerSandboxRuntimeDependencies(): Set<string> | undefined {
  const raw = process.env.JUNIOR_DOCKER_SANDBOX_RUNTIME_DEPENDENCIES;
  if (raw === undefined) return undefined;
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}
