import {
  createUserTokenStore,
  issueProviderCredentialLease,
} from "@/chat/capabilities/factory";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import type {
  AgentPluginAuthorization,
  AgentPluginGrant,
} from "@sentry/junior-plugin-api";
import {
  hasEgressCredentialHooks,
  selectPluginGrant,
  issuePluginCredential,
} from "@/chat/plugins/credential-hooks";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import {
  matchesSandboxEgressDomain,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress-policy";
import {
  getSandboxEgressCredentialLease,
  setSandboxEgressCredentialLease,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress-session";

const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type SandboxEgressGrantSelection =
  | {
      grant: AgentPluginGrant;
      source: "plugin";
    }
  | {
      grant: AgentPluginGrant;
      source: "broker";
    };

/** Signals that a plugin selected a grant but needs user authorization before issuing headers. */
export class SandboxEgressCredentialNeededError extends Error {
  readonly authorization?: AgentPluginAuthorization;
  readonly grant: AgentPluginGrant;
  readonly provider: string;

  constructor(input: {
    authorization?: AgentPluginAuthorization;
    grant: AgentPluginGrant;
    message: string;
    provider: string;
  }) {
    super(input.message);
    this.name = "SandboxEgressCredentialNeededError";
    this.authorization = input.authorization;
    this.grant = input.grant;
    this.provider = input.provider;
  }
}

function defaultGrantForProvider(input: {
  method: string;
  provider: string;
}): SandboxEgressGrantSelection {
  const access: AgentPluginGrant["access"] = HTTP_READ_METHODS.has(
    input.method.toUpperCase(),
  )
    ? "read"
    : "write";
  return {
    source: "broker",
    grant: {
      name: "default",
      access,
      reason: `sandbox-egress:${input.provider}:${access}`,
    },
  };
}

function oauthAuthorizationForProvider(
  provider: string,
): AgentPluginAuthorization | undefined {
  const oauth = getPluginOAuthConfig(provider);
  return oauth
    ? {
        type: "oauth",
        provider,
        ...(oauth.scope ? { scope: oauth.scope } : {}),
      }
    : undefined;
}

function credentialSubjectFromContext(
  context: SandboxEgressCredentialContext,
): { type: "user"; userId: string } | undefined {
  return "subject" in context.credentials && context.credentials.subject
    ? { type: "user", userId: context.credentials.subject.userId }
    : undefined;
}

function assertLeaseTransformsOwnedByProvider(
  provider: string,
  lease: Pick<SandboxEgressCredentialLease, "headerTransforms">,
): void {
  for (const transform of lease.headerTransforms) {
    if (resolveSandboxEgressProviderForHost(transform.domain) !== provider) {
      throw new Error(
        `Credential lease for ${provider} included header transform for unowned domain ${transform.domain}`,
      );
    }
  }
}

/** Select the plugin-defined or default grant needed for one outbound request. */
export async function selectSandboxEgressGrant(input: {
  method: string;
  provider: string;
  upstreamUrl: URL;
}): Promise<SandboxEgressGrantSelection> {
  if (!hasEgressCredentialHooks(input.provider)) {
    return defaultGrantForProvider(input);
  }

  const pluginGrant = await selectPluginGrant({
    provider: input.provider,
    method: input.method,
    upstreamUrl: input.upstreamUrl,
  });
  if (!pluginGrant) {
    throw new Error(
      `Plugin "${input.provider}" grantForEgress must return a grant for sandbox egress`,
    );
  }
  return { source: "plugin", grant: pluginGrant };
}

/** Resolve the authorization flow attached to a broker-selected egress grant. */
export function authorizationForSandboxEgressGrant(
  provider: string,
  selection: SandboxEgressGrantSelection,
): AgentPluginAuthorization | undefined {
  return selection.source === "broker"
    ? oauthAuthorizationForProvider(provider)
    : undefined;
}

/** Return a cached or newly issued credential lease for a selected grant. */
export async function sandboxEgressCredentialLease(
  provider: string,
  selection: SandboxEgressGrantSelection,
  context: SandboxEgressCredentialContext,
): Promise<SandboxEgressCredentialLease> {
  const { grant } = selection;
  const cached = await getSandboxEgressCredentialLease(
    provider,
    grant.name,
    context,
  );
  if (cached) {
    if (selection.source === "plugin" && cached.grant.access !== grant.access) {
      throw new Error(
        `Cached credential lease for ${provider}/${grant.name} has ${cached.grant.access} access, but ${grant.access} was selected`,
      );
    }
    return {
      ...cached,
      grant,
    };
  }

  let lease: {
    account?: SandboxEgressCredentialLease["account"];
    authorization?: AgentPluginAuthorization;
    expiresAt: string;
    headerTransforms?: SandboxEgressCredentialLease["headerTransforms"];
  };

  if (selection.source === "plugin") {
    const credentialSubject = credentialSubjectFromContext(context);
    const pluginResult = await issuePluginCredential({
      provider,
      grant,
      actor: context.credentials.actor,
      ...(credentialSubject ? { credentialSubject } : {}),
      userTokenStore: createUserTokenStore(),
    });
    if (pluginResult.type === "needed") {
      throw new SandboxEgressCredentialNeededError({
        provider,
        grant,
        authorization: pluginResult.authorization,
        message: pluginResult.message,
      });
    }
    if (pluginResult.type === "unavailable") {
      throw new CredentialUnavailableError(provider, pluginResult.message);
    }
    lease = pluginResult.lease;
  } else {
    lease = await issueProviderCredentialLease({
      context: context.credentials,
      provider,
      reason: grant.reason ?? `sandbox-egress:${provider}:default`,
    });
  }

  const headerTransforms = lease.headerTransforms ?? [];
  if (headerTransforms.length === 0) {
    throw new Error(
      `Credential lease for ${provider} did not include header transforms`,
    );
  }
  const leaseExpiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.now()) {
    throw new Error(`Credential lease for ${provider} is expired`);
  }

  const authorization =
    selection.source === "broker"
      ? oauthAuthorizationForProvider(provider)
      : lease.authorization;
  const cachedLease: SandboxEgressCredentialLease = {
    provider,
    grant,
    ...(lease.account ? { account: lease.account } : {}),
    ...(authorization ? { authorization } : {}),
    expiresAt: lease.expiresAt,
    headerTransforms,
  };
  assertLeaseTransformsOwnedByProvider(provider, cachedLease);
  await setSandboxEgressCredentialLease(context, cachedLease);
  return cachedLease;
}

/** Return whether a credential lease can modify requests to the target host. */
export function hasSandboxEgressLeaseTransformForHost(
  lease: SandboxEgressCredentialLease,
  host: string,
): boolean {
  return lease.headerTransforms.some((transform) =>
    matchesSandboxEgressDomain(host, transform.domain),
  );
}
