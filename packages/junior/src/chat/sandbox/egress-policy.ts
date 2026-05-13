import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { getPluginProviders } from "@/chat/plugins/registry";
import type { PluginDefinition } from "@/chat/plugins/types";
import { resolveBaseUrl } from "@/chat/oauth-flow";

export interface SandboxEgressProvider {
  provider: string;
  domains: string[];
}

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

function githubNeedsGitHost(plugin: PluginDefinition): boolean {
  if (plugin.manifest.name !== "github") {
    return false;
  }

  return plugin.manifest.capabilities.some(
    (capability) =>
      capability === "github.contents.read" ||
      capability === "github.contents.write",
  );
}

function pluginDomains(plugin: PluginDefinition): string[] {
  const domains = new Set<string>();
  for (const domain of plugin.manifest.credentials?.apiDomains ?? []) {
    domains.add(domain);
  }
  for (const domain of plugin.manifest.apiDomains ?? []) {
    domains.add(domain);
  }
  if (githubNeedsGitHost(plugin)) {
    domains.add("github.com");
  }
  return [...domains].sort((left, right) => left.localeCompare(right));
}

/** Return credential-capable plugin providers and the domains routed through the sandbox egress proxy. */
export function getSandboxEgressProviders(): SandboxEgressProvider[] {
  return getPluginProviders()
    .map((plugin) => ({
      provider: plugin.manifest.name,
      domains: pluginDomains(plugin),
    }))
    .filter((entry) => entry.domains.length > 0)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/** Resolve the plugin provider responsible for an outbound sandbox host. */
export function resolveSandboxEgressProviderForHost(
  host: string,
): string | undefined {
  for (const entry of getSandboxEgressProviders()) {
    if (
      entry.domains.some((domain) => matchesSandboxEgressDomain(host, domain))
    ) {
      return entry.provider;
    }
  }
  return undefined;
}

/** Build the proxy URL Vercel Sandbox firewall should forward matching egress requests to. */
export function buildSandboxEgressProxyUrl(
  sandboxId: string,
): string | undefined {
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
  const forwardURL = buildSandboxEgressProxyUrl(sandboxId);
  if (!forwardURL) {
    return undefined;
  }
  const providers = getSandboxEgressProviders();
  if (providers.length === 0) {
    return undefined;
  }

  const allow: Record<string, NetworkPolicyRule[]> = {
    "*": [],
  };
  for (const entry of providers) {
    for (const domain of entry.domains) {
      allow[domain] = [{ forwardURL }];
    }
  }

  return { allow };
}

/** Return non-secret command environment placeholders needed before CLIs make HTTP requests. */
export function getSandboxCommandEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const plugin of getPluginProviders().sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    Object.assign(env, plugin.manifest.commandEnv ?? {});
    const credentials = plugin.manifest.credentials;
    if (credentials) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
