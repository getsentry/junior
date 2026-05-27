import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { mergeHeaderTransforms } from "@/chat/credentials/header-transforms";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { resolveApiHeaderTransforms } from "./api-headers-broker";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import type { GitHubAppCredentials, PluginManifest } from "../types";

const MAX_LEASE_MS = 60 * 60 * 1000;

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

/**
 * GitHub App permission scopes that plugin manifests may request.
 * Manifest capabilities follow `<plugin>.<scope>.<read|write>` where the
 * scope name uses dashes in capabilities and underscores in the GitHub API.
 */
const KNOWN_SCOPES = new Set([
  "actions",
  "administration",
  "checks",
  "codespaces",
  "contents",
  "deployments",
  "environments",
  "issues",
  "metadata",
  "packages",
  "pages",
  "pull_requests",
  "repository_hooks",
  "repository_projects",
  "secret_scanning_alerts",
  "secrets",
  "security_events",
  "statuses",
  "vulnerability_alerts",
  "workflows",
]);

function capabilitiesToPermissions(
  capabilities: string[],
  pluginName: string,
): Record<string, "read" | "write"> {
  const permissions: Record<string, "read" | "write"> = {};
  const prefix = `${pluginName}.`;
  for (const capability of capabilities) {
    if (!capability.startsWith(prefix)) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }
    const suffix = capability.slice(prefix.length);

    const lastDot = suffix.lastIndexOf(".");
    if (lastDot === -1) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }
    const scopeRaw = suffix.slice(0, lastDot);
    const level = suffix.slice(lastDot + 1);
    if (level !== "read" && level !== "write") {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const scope = scopeRaw.replace(/-/g, "_");
    if (!KNOWN_SCOPES.has(scope)) {
      throw new Error(`Unsupported GitHub capability: ${capability}`);
    }

    const existing = permissions[scope];
    permissions[scope] =
      existing === "write" || level === "write" ? "write" : "read";
  }

  return permissions;
}

/** Create a broker that keeps GitHub App tokens on the host while authorizing provider traffic. */
export function createGitHubAppBroker(
  manifest: PluginManifest,
  credentials: GitHubAppCredentials,
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
    ? capabilitiesToPermissions(manifest.capabilities, provider)
    : undefined;

  function createLease(params: {
    installationId: number;
    token: string;
    expiresAtMs: number;
    reason: string;
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
        installationId: String(params.installationId),
        reason: params.reason,
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

  return {
    async issue(input: { reason: string }): Promise<CredentialLease> {
      const installationId = resolveInstallationId();
      const tokenRequestBody: Record<string, unknown> = permissions
        ? { permissions }
        : {};

      const appId = resolveAppId(appIdEnv);
      const appJwt = createAppJwt(appId, privateKeyEnv);

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
      });
    },
  };
}
