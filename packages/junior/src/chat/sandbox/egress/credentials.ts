import {
  createUserTokenStore,
  issueProviderCredentialLease,
} from "@/chat/capabilities/factory";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import type {
  PluginAuthorization,
  PluginGrant,
} from "@sentry/junior-plugin-api";
import {
  hasEgressCredentialHooks,
  selectPluginGrant,
  issuePluginCredential,
} from "@/chat/plugins/credential-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  matchesSandboxEgressDomain,
  resolveSandboxEgressProviderForHost,
} from "@/chat/sandbox/egress/policy";
import {
  getSandboxEgressCredentialLease,
  setSandboxEgressCredentialLease,
  type SandboxEgressCredentialContext,
  type SandboxEgressCredentialLease,
} from "@/chat/sandbox/egress/session";

// Module overview: select and issue provider credentials for sandbox egress.
//
// The proxy has already resolved a provider for the upstream host before this
// module runs. A plugin may choose a precise grant from the request method,
// URL, and limited body text; otherwise we fall back to the broker's default
// read/write grant. The result is a short-lived set of header transforms, never
// raw provider credentials inside the sandbox.

const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Describes whether grant selection came from plugin hooks or the broker default. */
export type SandboxEgressGrantSelection =
  | {
      grant: PluginGrant;
      source: "plugin";
    }
  | {
      grant: PluginGrant;
      source: "broker";
    };

export type SandboxEgressCredentialErrorKind = "auth_required" | "unavailable";

/**
 * Signals that egress selected a grant but could not issue credential headers.
 *
 * Callers convert this into command-level auth-required state so the agent can
 * request authorization without exposing provider-specific lease internals.
 */
export class SandboxEgressCredentialError extends Error {
  readonly authorization?: PluginAuthorization;
  readonly grant: PluginGrant;
  readonly kind: SandboxEgressCredentialErrorKind;
  readonly provider: string;

  constructor(input: {
    authorization?: PluginAuthorization;
    grant: PluginGrant;
    kind: SandboxEgressCredentialErrorKind;
    message: string;
    provider: string;
  }) {
    super(input.message);
    this.name = "SandboxEgressCredentialError";
    this.authorization = input.authorization;
    this.grant = input.grant;
    this.kind = input.kind;
    this.provider = input.provider;
  }
}

function defaultGrantForProvider(input: {
  method: string;
  provider: string;
}): SandboxEgressGrantSelection {
  const access: PluginGrant["access"] = HTTP_READ_METHODS.has(
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
): PluginAuthorization | undefined {
  const oauth = pluginCatalogRuntime.getOAuthConfig(provider);
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

/**
 * Select the grant needed for one outbound request.
 *
 * GitHub GraphQL and other plugin-owned APIs may need body-aware grant choices;
 * providers without hooks use a simple read/write default based on HTTP method.
 */
export async function selectSandboxEgressGrant(input: {
  bodyText?: string;
  method: string;
  operation?: string;
  provider: string;
  upstreamUrl: URL;
}): Promise<SandboxEgressGrantSelection> {
  if (!hasEgressCredentialHooks(input.provider)) {
    return defaultGrantForProvider(input);
  }

  const pluginGrant = await selectPluginGrant({
    ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
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

/**
 * Resolve the authorization flow attached to a broker-selected egress grant.
 *
 * Plugin-selected grants can return their own authorization metadata when
 * issuing credentials; broker defaults use the provider OAuth config.
 */
export function authorizationForSandboxEgressGrant(
  provider: string,
  selection: SandboxEgressGrantSelection,
): PluginAuthorization | undefined {
  return selection.source === "broker"
    ? oauthAuthorizationForProvider(provider)
    : undefined;
}

/**
 * Return cached or newly issued credential header transforms for a selected grant.
 *
 * Leases are cached per actor/context/grant, validated against provider-owned
 * domains, and reused only while both the provider lease and sandbox context are
 * still valid.
 */
export async function sandboxEgressCredentialLease(
  provider: string,
  selection: SandboxEgressGrantSelection,
  context: SandboxEgressCredentialContext,
): Promise<SandboxEgressCredentialLease> {
  const { grant } = selection;
  const cached = await getSandboxEgressCredentialLease(
    provider,
    grant,
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
    authorization?: PluginAuthorization;
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
      throw new SandboxEgressCredentialError({
        provider,
        grant,
        kind: "auth_required",
        authorization: pluginResult.authorization,
        message: pluginResult.message,
      });
    }
    if (pluginResult.type === "unavailable") {
      throw new SandboxEgressCredentialError({
        provider,
        grant,
        kind: "unavailable",
        message: pluginResult.message,
      });
    }
    lease = pluginResult.lease;
  } else {
    // Normalize broker credential-needed failures into the egress error shape.
    // All CredentialUnavailableError throws in oauth-bearer-broker are user-actionable
    // (missing token, scope gap, expired connection) and should trigger OAuth re-auth.
    try {
      lease = await issueProviderCredentialLease({
        context: context.credentials,
        provider,
        reason: grant.reason ?? `sandbox-egress:${provider}:default`,
      });
    } catch (error) {
      if (error instanceof CredentialUnavailableError) {
        throw new SandboxEgressCredentialError({
          provider,
          grant,
          kind: "auth_required",
          authorization: authorizationForSandboxEgressGrant(
            provider,
            selection,
          ),
          message: error.message,
        });
      }
      throw error;
    }
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
