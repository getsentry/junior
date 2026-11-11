import { randomUUID } from "node:crypto";
import type { CredentialBroker } from "@/chat/credentials/broker";
import { mintWorkloadIdentityToken } from "@/chat/credentials/workload-identity";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { workloadIdentityHeader } from "../workload-identity-manifest";
import type { PluginManifest, WorkloadIdentityCredentials } from "../types";

/**
 * Issue leases from a host-minted workload identity token.
 *
 * The lease holds only the minted token and expires with it. Egress keeps it
 * as a shared lease and mints again shortly before that time. Static plugin
 * `api-headers` are not part of the lease; egress resolves them from env on
 * each request so long-lived secrets never sit in shared host state.
 */
export function createWorkloadIdentityBroker(
  manifest: PluginManifest,
  credentials: WorkloadIdentityCredentials,
): CredentialBroker {
  const header = workloadIdentityHeader(credentials);
  return {
    async issue(input) {
      const minted = await mintWorkloadIdentityToken(
        manifest.name,
        credentials,
      );
      return {
        id: randomUUID(),
        provider: manifest.name,
        env: resolvePluginCommandEnv(manifest),
        headerTransforms: credentials.domains.map((domain) => ({
          domain,
          headers: { [header]: `Bearer ${minted.token}` },
        })),
        expiresAt: new Date(minted.expiresAtMs).toISOString(),
        metadata: { reason: input.reason },
      };
    },
  };
}
