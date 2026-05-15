import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { getPluginProviders } from "@/chat/plugins/registry";
import type { PluginManifest } from "@/chat/plugins/types";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { requireVercelSandboxOidcConfig } from "@/chat/sandbox/egress-oidc";

const SANDBOX_EGRESS_PROXY_PATH = "/api/internal/sandbox-egress";

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
  const entries = providerEntries();
  if (entries.length === 0) {
    return undefined;
  }
  const forwardURL = proxyUrl(sandboxId);
  if (!forwardURL) {
    throw new Error(
      "Cannot determine base URL for sandbox credential egress (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }
  requireVercelSandboxOidcConfig();

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

/** Resolve non-secret command environment values for registered sandbox providers. */
export async function resolveSandboxCommandEnvironment(): Promise<
  Record<string, string>
> {
  const env: Record<string, string> = {};
  for (const plugin of getPluginProviders().sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    Object.assign(env, resolvePluginCommandEnv(plugin.manifest));
    const credentials = plugin.manifest.credentials;
    if (credentials) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
