import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import type { CredentialHeaderTransform } from "@/chat/credentials/broker";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { getPluginProviders } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";

/** Return whether an outbound host is covered by a sandbox egress domain rule. */
export function matchesSandboxEgressDomain(
  host: string,
  domain: string,
): boolean {
  return host.toLowerCase() === domain.toLowerCase();
}

function manifestDomains(manifest: PluginManifest): string[] {
  const domains = new Set([
    ...(manifest.credentials?.domains ?? []),
    ...(manifest.domains ?? []),
  ]);
  return [...domains].sort((left, right) => left.localeCompare(right));
}

function providerEntries(): Array<{ provider: string; domains: string[] }> {
  return getPluginProviders()
    .map((plugin) => ({
      provider: plugin.manifest.name,
      domains: manifestDomains(plugin.manifest),
    }))
    .filter((entry) => entry.domains.length > 0)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase();
}

/** Resolve the plugin provider responsible for an outbound sandbox host. */
export function resolveSandboxEgressProviderForHost(
  host: string,
): string | undefined {
  return providerEntries().find((entry) =>
    entry.domains.some((domain) => matchesSandboxEgressDomain(host, domain)),
  )?.provider;
}

/** Return whether a provider can supply host-managed sandbox credential headers. */
export function hasSandboxCredentialEgress(provider: string): boolean {
  const plugin = getPluginProviders().find(
    (candidate) => candidate.manifest.name === provider,
  );
  return Boolean(plugin?.manifest.credentials || plugin?.manifest.apiHeaders);
}

function mergeHeaderTransforms(
  headerTransforms: CredentialHeaderTransform[],
): Map<string, Record<string, string>> {
  const headersByDomain = new Map<string, Record<string, string>>();
  for (const transform of headerTransforms) {
    const domain = normalizeDomain(transform.domain);
    const existing = headersByDomain.get(domain) ?? {};
    headersByDomain.set(domain, {
      ...existing,
      ...transform.headers,
    });
  }
  return headersByDomain;
}

/** Build the command-scoped policy that injects credential headers without rewriting URLs. */
export function buildSandboxEgressNetworkPolicy(input?: {
  headerTransforms?: CredentialHeaderTransform[];
}): NetworkPolicy {
  const headerTransforms = input?.headerTransforms ?? [];
  const headersByDomain = mergeHeaderTransforms(headerTransforms);
  const allow: Record<string, NetworkPolicyRule[]> = {
    "*": [],
  };

  for (const entry of providerEntries()) {
    for (const domain of entry.domains) {
      const headers = headersByDomain.get(normalizeDomain(domain));
      if (headers && Object.keys(headers).length > 0) {
        allow[domain] = [{ transform: [{ headers }] }];
      }
      headersByDomain.delete(normalizeDomain(domain));
    }
  }
  for (const [domain, headers] of [...headersByDomain.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (Object.keys(headers).length > 0) {
      allow[domain] = [{ transform: [{ headers }] }];
    }
  }

  return { allow };
}

/** Resolve non-secret command environment values for registered sandbox providers. */
export async function resolveSandboxCommandEnvironment(
  provider?: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const plugin of getPluginProviders().sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    if (provider && plugin.manifest.name !== provider) {
      continue;
    }
    Object.assign(env, resolvePluginCommandEnv(plugin.manifest));
    const credentials = plugin.manifest.credentials;
    if (credentials) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
