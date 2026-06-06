import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import {
  DEFAULT_GITHUB_SYSTEM_READ_SCOPES,
  githubCapabilitiesToPermissions,
  githubInstallationReadPermissions,
  githubSystemReadPermissionsFromScopes,
} from "@/chat/plugins/github-permissions";
import { resolveApiHeaderTransforms } from "./api-headers-broker";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "./oauth-request";
import type {
  GitHubAppCredentials,
  PluginBrokerDeps,
  PluginManifest,
} from "../types";

const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePrivateKey(raw: string): string {
  let normalized = raw.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  normalized = normalized.replace(/\r\n/g, "\n");
  if (normalized.includes("\\n")) {
    normalized = normalized.replace(/\\n/g, "\n");
  }

  if (!normalized.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
      if (decoded.includes("-----BEGIN")) {
        normalized = decoded;
      }
    } catch {
      // Intentionally ignore decode errors and let crypto validation fail with a clearer message.
    }
  }

  return normalized;
}

function getPrivateKey(envName: string) {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`Missing ${envName}`);
  }

  const normalized = normalizePrivateKey(raw);
  let key;
  try {
    key = createPrivateKey({ key: normalized, format: "pem" });
  } catch {
    throw new Error(
      `Invalid ${envName}: expected a PEM-encoded RSA private key (raw PEM, escaped newlines, or base64-encoded PEM)`,
    );
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `Invalid ${envName}: GitHub App signing requires an RSA private key`,
    );
  }

  return key;
}

function createAppJwt(appId: string, privateKeyEnv: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer
    .sign(getPrivateKey(privateKeyEnv))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
}

function resolveAppId(appIdEnv: string): string {
  const appId = process.env[appIdEnv]?.trim();
  if (!appId) {
    throw new Error(`Missing ${appIdEnv}`);
  }
  return appId;
}

async function githubRequest<T>(
  apiBase: string,
  path: string,
  params: {
    token: string;
    method?: string;
    body?: unknown;
  },
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(params.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string"
        ? parsed.message
        : `GitHub API error ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function resolveGitHubApiDomain(credentials: GitHubAppCredentials): string {
  const apiDomain = credentials.domains.find((domain) => {
    const normalizedDomain = domain.toLowerCase();
    return (
      normalizedDomain === "api.github.com" ||
      normalizedDomain.startsWith("api.")
    );
  });
  if (!apiDomain) {
    throw new Error("GitHub App provider requires an API domain");
  }
  return apiDomain;
}

async function refreshUserAccessToken(
  refreshToken: string,
  oauth: NonNullable<PluginManifest["oauth"]>,
  fallbackScope?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
}> {
  const clientId = process.env[oauth.clientIdEnv]?.trim();
  const clientSecret = process.env[oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing ${oauth.clientIdEnv} or ${oauth.clientSecretEnv} for GitHub user token refresh`,
    );
  }

  const request = buildOAuthTokenRequest({
    clientId,
    clientSecret,
    payload: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    tokenAuthMethod: oauth.tokenAuthMethod,
    tokenExtraHeaders: oauth.tokenExtraHeaders,
  });
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });

  if (!response.ok) {
    throw new Error(`GitHub user token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return parseOAuthTokenResponse(data, fallbackScope, {
    treatEmptyScopeAsUnreported: oauth.treatEmptyScopeAsUnreported,
  });
}

function leaseExpiry(expiresAt?: number): number {
  return expiresAt
    ? Math.min(expiresAt, Date.now() + MAX_LEASE_MS)
    : Date.now() + MAX_LEASE_MS;
}

/** Create a broker that keeps GitHub App tokens on the host while authorizing provider traffic. */
export function createGitHubAppBroker(
  manifest: PluginManifest,
  credentials: GitHubAppCredentials,
  deps?: PluginBrokerDeps,
): CredentialBroker {
  const provider = manifest.name;
  const {
    domains,
    apiHeaders,
    authTokenEnv,
    appIdEnv,
    privateKeyEnv,
    installationIdEnv,
  } = credentials;
  const apiDomain = resolveGitHubApiDomain(credentials);
  const apiBase = `https://${apiDomain}`;
  const placeholder = resolveAuthTokenPlaceholder(credentials);
  const pluginHeaderTransforms = () => resolveApiHeaderTransforms(manifest);

  const leaseDomains = [...new Set(domains)];

  /**
   * Build the correct Authorization header for a domain.
   *
   * Git smart-HTTP hosts require Basic auth with `x-access-token`. Other
   * GitHub service hosts use the same Bearer installation token as REST API.
   */
  function authorizationFor(domain: string, token: string): string {
    if (isGitSmartHttpDomain(domain)) {
      return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    }
    return `Bearer ${token}`;
  }

  function isGitSmartHttpDomain(domain: string): boolean {
    const normalizedDomain = domain.toLowerCase();
    const normalizedApiDomain = apiDomain.toLowerCase();
    return (
      normalizedDomain === "github.com" ||
      (normalizedApiDomain.startsWith("api.") &&
        normalizedDomain === normalizedApiDomain.slice("api.".length))
    );
  }

  const permissions = manifest.capabilities?.length
    ? githubCapabilitiesToPermissions(manifest.capabilities, provider)
    : undefined;
  const systemReadPermissions = credentials.systemReadPermissions?.length
    ? githubSystemReadPermissionsFromScopes(credentials.systemReadPermissions)
    : undefined;

  async function resolveTokenPermissions(params: {
    appJwt: string;
    installationId: number;
    systemActor: boolean;
  }) {
    if (!params.systemActor) {
      return permissions;
    }
    if (systemReadPermissions) {
      return systemReadPermissions;
    }

    const installation = await githubRequest<{
      permissions?: Record<string, string>;
    }>(apiBase, `/app/installations/${params.installationId}`, {
      token: params.appJwt,
    });
    return githubInstallationReadPermissions(
      installation.permissions,
      DEFAULT_GITHUB_SYSTEM_READ_SCOPES,
    );
  }

  function createLease(params: {
    installationId?: number;
    token: string;
    expiresAtMs: number;
    reason: string;
    tokenKind: "installation" | "user";
  }): CredentialLease {
    return {
      id: randomUUID(),
      provider,
      env: {
        ...resolvePluginCommandEnv(manifest),
        [authTokenEnv]: placeholder,
      },
      headerTransforms: mergeHeaderTransforms([
        ...pluginHeaderTransforms(),
        ...leaseDomains.map((domain) => ({
          domain,
          headers: {
            ...(apiHeaders ?? {}),
            Authorization: authorizationFor(domain, params.token),
          },
        })),
      ]),
      expiresAt: new Date(params.expiresAtMs).toISOString(),
      metadata: {
        ...(params.installationId !== undefined
          ? { installationId: String(params.installationId) }
          : {}),
        reason: params.reason,
        tokenKind: params.tokenKind,
      },
    };
  }

  function resolveInstallationId(): number {
    const installationIdRaw = process.env[installationIdEnv]?.trim();
    if (!installationIdRaw) {
      throw new Error(`Missing ${installationIdEnv}`);
    }
    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId)) {
      throw new Error(`Invalid ${installationIdEnv}`);
    }
    return installationId;
  }

  async function issueUserLease(input: {
    context: Parameters<CredentialBroker["issue"]>[0]["context"];
    reason: string;
  }): Promise<CredentialLease> {
    const oauth = manifest.oauth;
    if (
      !oauth ||
      !deps?.userTokenStore ||
      input.context.actor.type !== "user"
    ) {
      throw new CredentialUnavailableError(
        provider,
        "GitHub write access requires user authorization.",
      );
    }
    const userSubjectId = input.context.actor.userId;

    const stored = await deps.userTokenStore.get(userSubjectId, provider);
    if (!stored) {
      throw new CredentialUnavailableError(
        provider,
        "GitHub write access requires user authorization.",
      );
    }
    if (!hasRequiredOAuthScope(stored.scope, oauth.scope)) {
      throw new CredentialUnavailableError(
        provider,
        "Your GitHub authorization needs to be refreshed.",
      );
    }

    const now = Date.now();
    if (
      stored.expiresAt !== undefined &&
      stored.expiresAt - now < REFRESH_BUFFER_MS
    ) {
      try {
        const refreshed = await refreshUserAccessToken(
          stored.refreshToken,
          oauth,
          stored.scope ?? oauth.scope,
        );
        if (!hasRequiredOAuthScope(refreshed.scope, oauth.scope)) {
          throw new CredentialUnavailableError(
            provider,
            "Your GitHub authorization needs to be refreshed.",
          );
        }
        await deps.userTokenStore.set(userSubjectId, provider, refreshed);
        return createLease({
          token: refreshed.accessToken,
          expiresAtMs: leaseExpiry(refreshed.expiresAt),
          reason: input.reason,
          tokenKind: "user",
        });
      } catch (error) {
        if (error instanceof CredentialUnavailableError) {
          throw error;
        }
        if (stored.expiresAt > Date.now()) {
          return createLease({
            token: stored.accessToken,
            expiresAtMs: leaseExpiry(stored.expiresAt),
            reason: input.reason,
            tokenKind: "user",
          });
        }
        throw new CredentialUnavailableError(
          provider,
          "Your GitHub authorization has expired.",
        );
      }
    }

    if (stored.expiresAt === undefined || stored.expiresAt > Date.now()) {
      return createLease({
        token: stored.accessToken,
        expiresAtMs: leaseExpiry(stored.expiresAt),
        reason: input.reason,
        tokenKind: "user",
      });
    }

    throw new CredentialUnavailableError(
      provider,
      "Your GitHub authorization has expired.",
    );
  }

  async function issueInstallationLease(input: {
    context: Parameters<CredentialBroker["issue"]>[0]["context"];
    reason: string;
  }): Promise<CredentialLease> {
    const installationId = resolveInstallationId();
    const appId = resolveAppId(appIdEnv);
    const appJwt = createAppJwt(appId, privateKeyEnv);
    const tokenPermissions = await resolveTokenPermissions({
      appJwt,
      installationId,
      systemActor: input.context.actor.type === "system",
    });
    const tokenRequestBody: Record<string, unknown> = tokenPermissions
      ? { permissions: tokenPermissions }
      : {};

    const accessTokenResponse = await githubRequest<{
      token: string;
      expires_at: string;
    }>(apiBase, `/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      token: appJwt,
      body: tokenRequestBody,
    });

    const providerExpiresAtMs = Date.parse(accessTokenResponse.expires_at);
    const expiresAtMs = Math.min(
      providerExpiresAtMs,
      Date.now() + MAX_LEASE_MS,
    );

    return createLease({
      installationId,
      token: accessTokenResponse.token,
      expiresAtMs,
      reason: input.reason,
      tokenKind: "installation",
    });
  }

  return {
    async issue(input): Promise<CredentialLease> {
      if (input.intent === "write") {
        return await issueUserLease(input);
      }
      return await issueInstallationLease(input);
    },
  };
}
