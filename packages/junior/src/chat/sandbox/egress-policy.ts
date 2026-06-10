import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import type { TracePropagationHeaders } from "@/chat/logging";
import { SANDBOX_EGRESS_PROXY_PATH } from "@/chat/sandbox/egress-session";
import {
  shouldPropagateSandboxEgressTrace,
  type SandboxEgressTracePropagationConfig,
} from "@/chat/sandbox/egress-tracing";
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

/** Resolve the plugin provider responsible for an outbound sandbox host. */
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

/** Build the policy that forwards provider requests and configured trace headers. */
export function buildSandboxEgressNetworkPolicy(input?: {
  credentialToken?: string;
  traceConfig?: SandboxEgressTracePropagationConfig;
  traceHeaders?: TracePropagationHeaders;
}): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {
    "*": [],
  };
  const entries = providerEntries();
  if (entries.length === 0) {
    return { allow };
  }

  const forwardURL = sandboxProxyUrl(input?.credentialToken);
  const traceHeaders = Object.fromEntries(
    Object.entries(input?.traceHeaders ?? {}).filter(
      ([, value]) => typeof value === "string" && value.trim(),
    ),
  );
  for (const entry of entries) {
    for (const domain of entry.domains) {
      const shouldPropagateTrace = shouldPropagateSandboxEgressTrace(
        domain,
        input?.traceConfig,
      );
      allow[domain] = [
        {
          ...(shouldPropagateTrace && Object.keys(traceHeaders).length > 0
            ? { transform: [{ headers: traceHeaders }] }
            : {}),
          forwardURL,
        },
      ];
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
    if (credentials?.authTokenEnv) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
