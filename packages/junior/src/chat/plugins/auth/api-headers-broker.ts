import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialHeaderTransform,
  CredentialLease,
} from "@/chat/credentials/broker";
import type { PluginManifest } from "@/chat/plugins/types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function resolveHeaders(
  provider: string,
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const resolved = value.replace(ENV_PLACEHOLDER_RE, (_match, name) => {
        const envName = name as string;
        const envValue = process.env[envName]?.trim();
        if (!envValue) {
          throw new Error(
            `Missing ${envName} for API header provider "${provider}"`,
          );
        }
        return envValue;
      });
      return [key, resolved];
    }),
  );
}

/** Resolve plugin-level API headers into sandbox header transforms. */
export function resolveApiHeaderTransforms(
  manifest: PluginManifest,
): CredentialHeaderTransform[] {
  const { apiDomains, apiHeaders } = manifest;
  if (!apiDomains || !apiHeaders) {
    return [];
  }
  const resolvedHeaders = resolveHeaders(manifest.name, apiHeaders);
  return apiDomains.map((domain) => ({
    domain,
    headers: resolvedHeaders,
  }));
}

/** Issue host-managed API header transforms backed by deployment env vars. */
export function createApiHeadersBroker(
  manifest: PluginManifest,
): CredentialBroker {
  const provider = manifest.name;

  return {
    async issue(input): Promise<CredentialLease> {
      const headerTransforms = resolveApiHeaderTransforms(manifest);
      if (headerTransforms.length === 0) {
        throw new Error(`No API headers configured for plugin "${provider}"`);
      }
      return {
        id: randomUUID(),
        provider,
        env: { ...(manifest.commandEnv ?? {}) },
        headerTransforms,
        expiresAt: new Date(Date.now() + MAX_LEASE_MS).toISOString(),
        metadata: {
          reason: input.reason,
        },
      };
    },
  };
}
