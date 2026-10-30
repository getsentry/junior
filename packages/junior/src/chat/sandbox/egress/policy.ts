import type { TracePropagationHeaders } from "@/chat/logging";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress/tracing";
import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginManifest } from "@/chat/plugins/types";
import type { SandboxNetworkPolicy } from "@/chat/sandbox/workspace";

// Module overview: build the provider-neutral Sandbox network policy for
// provider-owned outbound domains.
//
// Provider domains go back to Junior so the host can inject credentials
// without placing secrets in the sandbox. Trace-only domains may receive
// configured trace headers in place. Each sandbox provider turns this policy
// into its own network rules. The egress proxy still revalidates provider
// ownership, because network policy is a routing guard, not the authorization
// boundary.

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

/**
 * Build the provider-neutral egress policy for one sandbox command context.
 *
 * Provider domains go through Junior's credentialed egress when a signed
 * credential token is given. The token binds each request to the actor and
 * sandbox VM that created the command. Configured trace-only domains get trace
 * headers in place. The sandbox receives placeholder env vars, not provider
 * credentials.
 */
export function buildSandboxEgressNetworkPolicy(input?: {
  credentialToken?: string;
  traceConfig?: SandboxEgressTracePropagationConfig;
  traceHeaders?: TracePropagationHeaders;
}): Exclude<SandboxNetworkPolicy, "allow-all"> {
  const credentialToken = input?.credentialToken;
  const credentialDomains = credentialToken
    ? [...new Set(providerEntries().flatMap((entry) => entry.domains))].sort(
        (left, right) => left.localeCompare(right),
      )
    : [];
  const traceHeaders = Object.fromEntries(
    Object.entries(input?.traceHeaders ?? {}).filter(
      ([, value]) => typeof value === "string" && value.trim(),
    ),
  );
  // A domain is in at most one list. Credentialed domains do not also get
  // trace headers in place.
  const traceDomains =
    Object.keys(traceHeaders).length > 0
      ? [...new Set(input?.traceConfig?.domains ?? [])]
          .filter(
            (domain) =>
              !credentialDomains.includes(domain) &&
              shouldPropagateSandboxEgressTrace(domain, input?.traceConfig),
          )
          .sort((left, right) => left.localeCompare(right))
      : [];

  return {
    ...(credentialToken && credentialDomains.length > 0
      ? { credentialEgress: { credentialToken, domains: credentialDomains } }
      : undefined),
    ...(traceDomains.length > 0
      ? { traceHeaders: { domains: traceDomains, headers: traceHeaders } }
      : undefined),
  };
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
