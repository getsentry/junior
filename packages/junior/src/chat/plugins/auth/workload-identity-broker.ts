import { randomUUID } from "node:crypto";
import type { CredentialBroker } from "@/chat/credentials/broker";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";
import { mintWorkloadIdentityToken } from "@/chat/credentials/workload-identity";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { workloadIdentityHeader } from "../workload-identity-manifest";
import { resolveApiHeaderTransforms } from "./api-headers-broker";
import type { PluginManifest, WorkloadIdentityCredentials } from "../types";

/**
 * Issue leases from a host-minted workload identity token.
 *
 * The lease expires with the token. Egress keeps it as a shared lease and
 * mints again shortly before that time. Static plugin `api-headers` ride on
 * the same lease, so a domain can get both, such as Redash's own
 * `Authorization: Key ...` next to an IAP `Proxy-Authorization` token.
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
        headerTransforms: mergeHeaderTransforms([
          ...resolveApiHeaderTransforms(manifest),
          ...credentials.domains.map((domain) => ({
            domain,
            headers: { [header]: `Bearer ${minted.token}` },
          })),
        ]),
        expiresAt: new Date(minted.expiresAtMs).toISOString(),
        metadata: { reason: input.reason },
      };
    },
  };
}
