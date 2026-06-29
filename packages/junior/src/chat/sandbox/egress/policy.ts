import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import type { TracePropagationHeaders } from "@/chat/logging";
import { SANDBOX_EGRESS_PROXY_PATH } from "@/chat/sandbox/egress/session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginManifest } from "@/chat/plugins/types";

// Module overview: build Vercel Sandbox network policy for provider-owned
// outbound domains.
//
// Provider domains are forwarded back to Junior so the host can inject
// credentials without placing secrets in the sandbox. Trace-only domains may
// receive configured trace headers without forwarding. The actual proxy handler
// still revalidates provider ownership, because network policy is a routing
// guard, not the authorization boundary.

/** Return whether an outbound host is covered by a provider domain rule. */
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
  return pluginCatalogRuntime
    .getProviders()
    .map((plugin) => ({
      provider: plugin.manifest.name,
      domains: manifestDomains(plugin.manifest),
    }))
    .filter((entry) => entry.domains.length > 0)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/**
 * Resolve the plugin provider responsible for an outbound sandbox host.
 *
 * Only plugin-declared provider domains are eligible for credentialed sandbox
 * egress. Hosts without a matching provider are blocked by the proxy even if a
 * malformed or stale network policy tried to forward them.
 */
export function resolveSandboxEgressProviderForHost(
  host: string,
): string | undefined {
  return providerEntries().find((entry) =>
    entry.domains.some((domain) => matchesSandboxEgressDomain(host, domain)),
  )?.provider;
}

function sandboxProxyUrl(credentialToken?: string): string {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL for sandbox credential egress (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }
  const path = credentialToken
    ? `${SANDBOX_EGRESS_PROXY_PATH}/${credentialToken}`
    : SANDBOX_EGRESS_PROXY_PATH;
  return new URL(path, baseUrl).toString();
}

/**
 * Build the policy that forwards provider domains through the egress proxy.
 *
 * The signed credential token is embedded in the forward URL so the proxy can
 * bind each forwarded request back to the actor and sandbox VM that created the
 * command. The sandbox receives placeholder env vars, not provider credentials.
 */
export function buildSandboxEgressNetworkPolicy(input?: {
  credentialToken?: string;
  traceConfig?: SandboxEgressTracePropagationConfig;
  traceHeaders?: TracePropagationHeaders;
}): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {
    "*": [],
  };
  const entries = providerEntries();
  const traceHeaders = Object.fromEntries(
    Object.entries(input?.traceHeaders ?? {}).filter(
      ([, value]) => typeof value === "string" && value.trim(),
    ),
  );
  const hasTraceHeaders = Object.keys(traceHeaders).length > 0;
  if (
    entries.length === 0 &&
    (!hasTraceHeaders || (input?.traceConfig?.domains ?? []).length === 0)
  ) {
    return { allow };
  }

  const forwardURL = input?.credentialToken
    ? sandboxProxyUrl(input.credentialToken)
    : undefined;
  const domains = new Map<string, { forward: boolean }>();
  // Provider domains are proxied for credentials; configured trace-only domains
  // get transform-only rules so wildcard trace configs are not limited to plugins.
  if (forwardURL) {
    for (const entry of entries) {
      for (const domain of entry.domains) {
        domains.set(domain, { forward: true });
      }
    }
  }
  if (hasTraceHeaders) {
    for (const domain of input?.traceConfig?.domains ?? []) {
      domains.set(domain, { forward: domains.get(domain)?.forward ?? false });
    }
  }

  for (const [domain, policy] of [...domains.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const shouldPropagateTrace = shouldPropagateSandboxEgressTrace(
      domain,
      input?.traceConfig,
    );
    allow[domain] = [
      {
        ...(shouldPropagateTrace && hasTraceHeaders
          ? { transform: [{ headers: traceHeaders }] }
          : {}),
        ...(policy.forward && forwardURL ? { forwardURL } : {}),
      },
    ];
  }

  return { allow };
}

/**
 * Resolve non-secret command environment values for registered sandbox providers.
 *
 * Credential env vars are placeholders that tell tools which auth variable name
 * exists; real credential headers are issued lazily by host egress.
 */
export async function resolveSandboxCommandEnvironment(): Promise<
  Record<string, string>
> {
  const env: Record<string, string> = {};
  for (const plugin of pluginCatalogRuntime
    .getProviders()
    .sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    )) {
    Object.assign(env, resolvePluginCommandEnv(plugin.manifest));
    const credentials = plugin.manifest.credentials;
    if (credentials?.authTokenEnv) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
