import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import type { CapabilityTarget } from "@/chat/capabilities/types";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";

// Spec: specs/skill-capabilities-spec.md (GitHub broker behavior)
// Spec: specs/security-policy.md (short-lived credential issuance and custody)
const API_BASE = "https://api.github.com";
const MAX_LEASE_MS = 60 * 60 * 1000;

type CachedInstallationToken = {
  installationId: number;
  token: string;
  expiresAt: number;
};

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

function getPrivateKey() {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error("Missing GITHUB_APP_PRIVATE_KEY");
  }

  const normalized = normalizePrivateKey(raw);
  let key;
  try {
    key = createPrivateKey({ key: normalized, format: "pem" });
  } catch {
    throw new Error(
      "Invalid GITHUB_APP_PRIVATE_KEY: expected a PEM-encoded RSA private key (raw PEM, escaped newlines, or base64-encoded PEM)"
    );
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("Invalid GITHUB_APP_PRIVATE_KEY: GitHub App signing requires an RSA private key");
  }

  return key;
}

function createAppJwt(appId: string): string {
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
    .sign(getPrivateKey())
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
}

async function githubRequest<T>(path: string, params: {
  token: string;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(params.body ? { "Content-Type": "application/json" } : {})
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {})
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
      parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message
        : `GitHub API error ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function parseTarget(target?: CapabilityTarget): { owner: string; repo: string } {
  const owner = target?.owner?.trim();
  const repo = target?.repo?.trim();
  if (!owner || !repo) {
    throw new Error("GitHub capability requests require target owner and repo");
  }
  return { owner, repo };
}

function capabilityToPermissions(capability: string): Record<string, "read" | "write"> {
  if (capability === "github.issues.read") {
    return { issues: "read" };
  }

  if (capability === "github.issues.write" || capability === "github.issues.comment" || capability === "github.labels.write") {
    return { issues: "write" };
  }

  throw new Error(`Unsupported GitHub capability: ${capability}`);
}

export class GitHubCredentialBroker implements CredentialBroker {
  private readonly tokenCache = new Map<string, CachedInstallationToken>();

  async issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease> {
    const permissions = capabilityToPermissions(input.capability);
    const appId = process.env.GITHUB_APP_ID;
    const { owner, repo } = parseTarget(input.target);
    if (!appId) {
      throw new Error("Missing GITHUB_APP_ID");
    }

    const cacheKey = `${owner}/${repo}:${input.capability}`;
    const cached = this.tokenCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt - now > 2 * 60 * 1000) {
      return {
        id: randomUUID(),
        provider: "github",
        capability: input.capability,
        env: { GITHUB_TOKEN: cached.token },
        expiresAt: new Date(cached.expiresAt).toISOString(),
        metadata: {
          owner,
          repo,
          installationId: String(cached.installationId),
          reason: input.reason
        }
      };
    }

    const appJwt = createAppJwt(appId);

    const installationId = process.env.GITHUB_INSTALLATION_ID
      ? Number(process.env.GITHUB_INSTALLATION_ID)
      : Number(
          (
            await githubRequest<{ id: number }>(`/repos/${owner}/${repo}/installation`, {
              token: appJwt
            })
          ).id
        );

    const accessTokenResponse = await githubRequest<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        token: appJwt,
        body: { permissions }
      }
    );

    const providerExpiresAtMs = Date.parse(accessTokenResponse.expires_at);
    const expiresAtMs = Math.min(providerExpiresAtMs, Date.now() + MAX_LEASE_MS);
    this.tokenCache.set(cacheKey, {
      installationId,
      token: accessTokenResponse.token,
      expiresAt: expiresAtMs
    });

    return {
      id: randomUUID(),
      provider: "github",
      capability: input.capability,
      env: { GITHUB_TOKEN: accessTokenResponse.token },
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: {
        owner,
        repo,
        installationId: String(installationId),
        reason: input.reason
      }
    };
  }
}
