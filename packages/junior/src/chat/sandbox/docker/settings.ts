import os from "node:os";
import path from "node:path";
import { getChatConfig } from "@/chat/config";

// Module overview: local settings of the Docker sandbox provider, from the
// sandbox config group.

/** Label on every container, network, and image that this provider owns. */
export const DOCKER_SANDBOX_LABEL = "dev.junior.sandbox";

/**
 * Directory for machine-wide provider files, such as the egress CA key.
 * `JUNIOR_DOCKER_SANDBOX_DIR` overrides the default.
 */
export function dockerSandboxDir(): string {
  const configured = getChatConfig().sandbox.docker.dir;
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
  return getChatConfig().sandbox.docker.extraCaCertsFile;
}
