import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import type { CapabilityTarget } from "@/chat/capabilities/types";
import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import { resolveAuthTokenPlaceholder } from "./auth-token-placeholder";
import type { GitHubAppCredentials, PluginManifest } from "../types";

const MAX_LEASE_MS = 60 * 60 * 1000;

type CachedInstallationToken = {
  installationId: number;
  token: string;
  expiresAt: number;
};

function normalizeTargetScope(target?: CapabilityTarget): string {
  const owner = target?.owner?.trim().toLowerCase();
  const repo = target?.repo?.trim().toLowerCase();
  if (!owner || !repo) {
    return "all";
  }
  return `${owner}/${repo}`;
}

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

/**
 * Capability aliases that map to a different GitHub permission than their name implies.
 * Key: suffix after plugin name (e.g. "issues.comment"), value: `{ permission, level }`.
 */
const CAPABILITY_ALIASES: Record<
  string,
  { permission: string; level: "read" | "write" }
> = {
  "issues.comment": { permission: "issues", level: "write" },
  "labels.write": { permission: "issues", level: "write" },
};

/**
 * GitHub App permission scopes that the broker can request.
 * Capabilities follow the convention `<plugin>.<scope>.<read|write>` where
 * the scope name uses dashes in capabilities and underscores in the GitHub API.
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

/** Map a capability string to the GitHub App permission it requires. */
function capabilityToPermissions(
  capability: string,
  pluginName: string,
): Record<string, "read" | "write"> {
  const prefix = `${pluginName}.`;
  if (!capability.startsWith(prefix)) {
    throw new Error(`Unsupported GitHub capability: ${capability}`);
  }
  const suffix = capability.slice(prefix.length);

  const alias = CAPABILITY_ALIASES[suffix];
  if (alias) {
    return { [alias.permission]: alias.level };
  }

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

  return { [scope]: level };
}

export function createGitHubAppBroker(
  manifest: PluginManifest,
  credentials: GitHubAppCredentials,
): CredentialBroker {
  const tokenCache = new Map<string, CachedInstallationToken>();
  const provider = manifest.name;
  const {
    apiDomains,
    apiHeaders,
    authTokenEnv,
    appIdEnv,
    privateKeyEnv,
    installationIdEnv,
  } = credentials;
  const apiBase = `https://${apiDomains[0]}`;
  const placeholder = resolveAuthTokenPlaceholder(credentials);

  /**
   * Capabilities that require git HTTPS auth (github.com, not just api.github.com).
   * The sandbox network proxy intercepts HTTPS traffic to these domains and injects
   * the real token via headerTransforms — `gh` and `git` authenticate through the
   * proxy, not via the GITHUB_TOKEN env var (which holds a placeholder).
   */
  const GIT_DOMAIN = "github.com";
  const GIT_CAPABILITIES = new Set([
    `${provider}.contents.read`,
    `${provider}.contents.write`,
  ]);
  function leaseDomainsFor(capability: string): string[] {
    return GIT_CAPABILITIES.has(capability)
      ? [...apiDomains, GIT_DOMAIN]
      : apiDomains;
  }

  const supportedCapabilities = new Set(manifest.capabilities);

  return {
    async issue(input: {
      capability: string;
      target?: CapabilityTarget;
      reason: string;
    }): Promise<CredentialLease> {
      if (!supportedCapabilities.has(input.capability)) {
        throw new Error(
          `Unsupported ${provider} capability: ${input.capability}`,
        );
      }
      const permissions = capabilityToPermissions(input.capability, provider);
      const appId = process.env[appIdEnv];
      if (!appId) {
        throw new Error(`Missing ${appIdEnv}`);
      }
      const installationIdRaw = process.env[installationIdEnv]?.trim();
      if (!installationIdRaw) {
        throw new Error(`Missing ${installationIdEnv}`);
      }
      const installationId = Number(installationIdRaw);
      if (!Number.isFinite(installationId)) {
        throw new Error(`Invalid ${installationIdEnv}`);
      }

      const targetScope = normalizeTargetScope(input.target);
      const cacheKey = `${installationId}:${input.capability}:${targetScope}`;
      const cached = tokenCache.get(cacheKey);
      const now = Date.now();
      if (cached && cached.expiresAt - now > 2 * 60 * 1000) {
        const domains = leaseDomainsFor(input.capability);
        return {
          id: randomUUID(),
          provider,
          capability: input.capability,
          env: { [authTokenEnv]: placeholder },
          headerTransforms: domains.map((domain) => ({
            domain,
            headers: {
              ...(apiHeaders ?? {}),
              Authorization: `Bearer ${cached.token}`,
            },
          })),
          expiresAt: new Date(cached.expiresAt).toISOString(),
          metadata: {
            installationId: String(cached.installationId),
            targetScope,
            reason: input.reason,
          },
        };
      }

      const appJwt = createAppJwt(appId, privateKeyEnv);
      const repositoryName = input.target?.repo?.trim().toLowerCase();
      const tokenRequestBody: {
        permissions: Record<string, "read" | "write">;
        repositories?: string[];
      } = {
        permissions,
      };
      if (repositoryName) {
        tokenRequestBody.repositories = [repositoryName];
      }

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
      tokenCache.set(cacheKey, {
        installationId,
        token: accessTokenResponse.token,
        expiresAt: expiresAtMs,
      });

      const domains = leaseDomainsFor(input.capability);
      return {
        id: randomUUID(),
        provider,
        capability: input.capability,
        env: { [authTokenEnv]: placeholder },
        headerTransforms: domains.map((domain) => ({
          domain,
          headers: {
            ...(apiHeaders ?? {}),
            Authorization: `Bearer ${accessTokenResponse.token}`,
          },
        })),
        expiresAt: new Date(expiresAtMs).toISOString(),
        metadata: {
          installationId: String(installationId),
          targetScope,
          reason: input.reason,
        },
      };
    },
  };
}
