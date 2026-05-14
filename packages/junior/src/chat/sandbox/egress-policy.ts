import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolveGitHubAppGitIdentityEnv } from "@/chat/plugins/auth/github-app-broker";
import { getPluginProviders } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";
import { resolveBaseUrl } from "@/chat/oauth-flow";

const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

/** Return whether an outbound host is covered by a sandbox egress domain rule. */
export function matchesSandboxEgressDomain(
  host: string,
  domain: string,
): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  if (normalizedDomain.startsWith("*.")) {
    const suffix = normalizedDomain.slice(1);
    return normalizedHost.endsWith(suffix);
  }
  return normalizedHost === normalizedDomain;
}

function withApex(domain: string): string[] {
  return domain.startsWith("*.") ? [domain, domain.slice(2)] : [domain];
}

function manifestDomains(manifest: PluginManifest): string[] {
  const domains = new Set(
    [
      ...(manifest.credentials?.domains ?? []),
      ...(manifest.domains ?? []),
    ].flatMap(withApex),
  );
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

/** Return plugin provider names that can route sandbox egress through Junior. */
export function getSandboxEgressProviderNames(): string[] {
  return providerEntries().map((entry) => entry.provider);
}

/** Resolve the plugin provider responsible for an outbound sandbox host. */
export function resolveSandboxEgressProviderForHost(
  host: string,
): string | undefined {
  return providerEntries().find((entry) =>
    entry.domains.some((domain) => matchesSandboxEgressDomain(host, domain)),
  )?.provider;
}

function proxyUrl(sandboxId: string): string | undefined {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return undefined;
  }
  const url = new URL(
    `${SANDBOX_EGRESS_PROXY_PATH}/${encodeURIComponent(sandboxId)}`,
    baseUrl,
  );
  return url.toString();
}

/** Build the Vercel Sandbox network policy that forwards credentialed provider domains to Junior. */
export function buildSandboxEgressNetworkPolicy(
  sandboxId: string,
): NetworkPolicy | undefined {
  const forwardURL = proxyUrl(sandboxId);
  if (!forwardURL) {
    return undefined;
  }
  const entries = providerEntries();
  if (entries.length === 0) {
    return undefined;
  }

  const allow: Record<string, NetworkPolicyRule[]> = {
    "*": [],
  };
  for (const entry of entries) {
    for (const domain of entry.domains) {
      allow[domain] = [{ forwardURL }];
    }
  }

  return { allow };
}

/** Resolve non-secret command environment values for active sandbox providers. */
export async function resolveSandboxCommandEnvironment(
  providers: string[],
): Promise<Record<string, string>> {
  const activeProviders = new Set(providers);
  const env: Record<string, string> = {};
  for (const plugin of getPluginProviders().sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    if (!activeProviders.has(plugin.manifest.name)) {
      continue;
    }
    Object.assign(env, plugin.manifest.commandEnv ?? {});
    const credentials = plugin.manifest.credentials;
    if (credentials) {
      if (credentials.type === "github-app") {
        Object.assign(env, await resolveGitHubAppGitIdentityEnv(credentials));
      }
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
