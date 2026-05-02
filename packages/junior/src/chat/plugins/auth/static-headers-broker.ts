import { randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import type {
  PluginManifest,
  StaticHeadersCredentials,
} from "@/chat/plugins/types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const ENV_REFERENCE_RE = /^\$([A-Z][A-Z0-9_]*)$/;

function resolveHeaders(
  provider: string,
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const match = value.match(ENV_REFERENCE_RE);
      if (!match) {
        return [key, value];
      }

      const envName = match[1] as string;
      const envValue = process.env[envName]?.trim();
      if (!envValue) {
        throw new Error(
          `Missing ${envName} for static headers credential provider "${provider}"`,
        );
      }
      return [key, envValue];
    }),
  );
}

/** Issue host-managed static header transforms backed by deployment env vars. */
export function createStaticHeadersBroker(
  manifest: PluginManifest,
  credentials: StaticHeadersCredentials,
): CredentialBroker {
  const provider = manifest.name;

  return {
    async issue(input): Promise<CredentialLease> {
      const resolvedHeaders = resolveHeaders(provider, credentials.apiHeaders);
      return {
        id: randomUUID(),
        provider,
        env: {},
        headerTransforms: credentials.apiDomains.map((domain) => ({
          domain,
          headers: resolvedHeaders,
        })),
        expiresAt: new Date(Date.now() + MAX_LEASE_MS).toISOString(),
        metadata: {
          reason: input.reason,
        },
      };
    },
  };
}
