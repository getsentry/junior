/**
 * GitHub credential issuance and provider request support.
 *
 * This module owns OAuth refresh, installation tokens, credential leases, and
 * installation and user credential parsing.
 */
import { createPrivateKey, createSign } from "node:crypto";
import type {
  PluginCredentialResult,
  PluginGrant,
  PluginProviderAccount,
  PluginStoredTokens,
  PluginUserTokenSlot,
  IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";
import {
  type GitHubAppPermissions,
  readGrantPermissions,
} from "./permissions.js";

export type JsonRecord = Record<string, unknown>;
export type GitHubGrantName =
  | "installation-read"
  | "installation-write"
  | "user-read"
  | "user-write";
export type GitHubGrantReason =
  | "github.api-read"
  | "github.asset-upload"
  | "github.git-read"
  | "github.graphql-read"
  | "github.installation-write"
  | "github.user-read"
  | "github.user-write";
export type GitHubGrant = PluginGrant & {
  name: GitHubGrantName;
  reason: GitHubGrantReason;
};

interface GitHubRequestParams {
  body?: unknown;
  method?: string;
  token: string;
}

interface OAuthTokenRequestInput {
  clientId: string;
  clientSecret: string;
  payload: Record<string, string>;
}

interface RefreshUserAccessTokenInput {
  clientIdEnv: string;
  clientSecretEnv: string;
  refreshToken: string;
  requestedScope?: string;
}

interface CredentialLeaseInput {
  account?: PluginProviderAccount;
  authorization?: {
    provider: "github";
    scope?: string;
    type: "oauth";
  };
  domains?: string[];
  expiresAtMs: number;
  token: string;
}

type TokenResolution =
  | { ok: true; tokens: PluginStoredTokens }
  | { ok: false; result: PluginCredentialResult };

interface UserCredentialOptions {
  clientIdEnv: string;
  clientSecretEnv: string;
  userScope?: string;
}

interface InstallationCredentialBaseOptions {
  appIdEnv: string;
  installationIdEnv: string;
  privateKeyEnv: string;
}

type InstallationCredentialOptions = InstallationCredentialBaseOptions &
  (
    | {
        // Optional downscope. Omit both for the full installation envelope.
        loadPermissions?: never;
        permissions?: GitHubAppPermissions;
        repositories?: string[];
      }
    | {
        loadPermissions: LoadInstallationReadPermissions;
        permissions?: never;
        repositories?: never;
      }
  );

type LoadInstallationReadPermissions = (input: {
  appJwt: string;
  installationId: number;
}) => Promise<Record<string, "read">>;

interface GitHubRepository {
  name: string;
  owner: string;
}

export const GITHUB_APP_ID_ENV = "GITHUB_APP_ID";
export const GITHUB_APP_PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY";
export const GITHUB_INSTALLATION_ID_ENV = "GITHUB_INSTALLATION_ID";
export const GITHUB_AUTH_TOKEN_ENV = "GITHUB_TOKEN";
export const GITHUB_AUTH_TOKEN_PLACEHOLDER = "ghp_host_managed_credential";
const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const USER_REFRESH_TIMEOUT_MS = 20_000;
export const GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
export const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const USER_TOKEN_GRANTS = new Set(["user-read", "user-write"]);
export const CREATE_TOOL_ROUTING_GUIDANCE =
  "This is a Junior tool-routing denial, not a GitHub permission failure. Do not ask the user for GitHub permissions; retry with the required Junior tool.";
export const USER_WRITE_REQUIREMENTS = [
  "requesting GitHub user permission to perform this operation",
];
const GITHUB_CREDENTIAL_DOMAINS = ["api.github.com", "github.com"];
const GITHUB_ASSET_UPLOAD_CREDENTIAL_DOMAINS = [
  ...GITHUB_CREDENTIAL_DOMAINS,
  "uploads.github.com",
];

class GitHubUserRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUserRefreshRejectedError";
  }
}

class GitHubRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

export class GitHubPluginSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPluginSetupError";
  }
}

/** Return whether a provider value is a JSON object. */
export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Read a non-empty GitHub plugin environment value. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Read a required GitHub plugin environment value. */
export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new GitHubPluginSetupError(`Missing ${name}`);
  }
  return value;
}

/** Normalize configured GitHub OAuth scopes. */
export function normalizeScopeList(scopes?: string[]): string[] {
  return [
    ...new Set(
      (scopes ?? [])
        .flatMap((scope) => String(scope).split(/\s+/))
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeOAuthScope(scope?: string): string | undefined {
  const normalized = normalizeScopeList(scope ? [scope] : []);
  return normalized.length ? normalized.join(" ") : undefined;
}

function hasRequiredOAuthScope(
  storedScope?: string,
  requiredScope?: string,
): boolean {
  const required = normalizeScopeList(requiredScope ? [requiredScope] : []);
  if (required.length === 0) {
    return true;
  }
  const stored = new Set(normalizeScopeList(storedScope ? [storedScope] : []));
  if (stored.size === 0) {
    return false;
  }
  return required.every((scope) => stored.has(scope));
}

function isGitHubApiUrl(upstreamUrl: URL): boolean {
  return upstreamUrl.hostname.toLowerCase() === "api.github.com";
}

function base64Url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getPrivateKey(envName: string) {
  const raw = requireEnv(envName);
  let key;
  try {
    key = createPrivateKey({ key: raw, format: "pem" });
  } catch {
    throw new GitHubPluginSetupError(
      `Invalid ${envName}: expected a PEM-encoded RSA private key`,
    );
  }

  if (key.asymmetricKeyType !== "rsa") {
    throw new GitHubPluginSetupError(
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

/** Send an authenticated request to the GitHub API. */
export async function githubRequest(
  apiBase: string,
  path: string,
  params: GitHubRequestParams,
): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(params.body ? { "Content-Type": "application/json" } : undefined),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : undefined),
  });

  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.message === "string"
        ? parsed.message
        : `GitHub API error ${response.status}`;
    throw new GitHubRequestError(message, response.status);
  }
  return parsed;
}

function buildOAuthTokenRequest(input: OAuthTokenRequestInput): {
  body: URLSearchParams;
  headers: Record<string, string>;
} {
  const payload = {
    ...input.payload,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  };
  return {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload),
  };
}

function parseOAuthResponseJson(responseText: string): unknown {
  if (!responseText.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return undefined;
  }
}

function oauthErrorCode(data: unknown): string | undefined {
  return isRecord(data) && typeof data.error === "string"
    ? data.error
    : undefined;
}

function isRejectedRefreshError(errorCode: string | undefined): boolean {
  return errorCode === "bad_refresh_token" || errorCode === "invalid_grant";
}

function parseOAuthTokenResponse(
  data: unknown,
  requestedScope?: string,
): PluginStoredTokens {
  if (!isRecord(data)) {
    throw new Error("OAuth token response is invalid");
  }
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("OAuth token response missing access_token");
  }
  if (typeof data.refresh_token !== "string" || !data.refresh_token.trim()) {
    throw new Error("OAuth token response missing refresh_token");
  }
  let scope = normalizeOAuthScope(requestedScope);
  if (data.scope !== undefined) {
    if (typeof data.scope !== "string") {
      throw new Error("OAuth token response returned invalid scope");
    }
    scope = normalizeOAuthScope(data.scope) ?? scope;
  }
  const result: PluginStoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    ...(scope ? { scope } : undefined),
  };
  if (data.expires_in !== undefined) {
    if (
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new Error("OAuth token response returned invalid expires_in");
    }
    result.expiresAt = Date.now() + data.expires_in * 1000;
  }
  if (data.refresh_token_expires_in !== undefined) {
    if (
      typeof data.refresh_token_expires_in !== "number" ||
      !Number.isFinite(data.refresh_token_expires_in) ||
      data.refresh_token_expires_in <= 0
    ) {
      throw new Error(
        "OAuth token response returned invalid refresh_token_expires_in",
      );
    }
    result.refreshTokenExpiresAt =
      Date.now() + data.refresh_token_expires_in * 1000;
  }
  return result;
}

async function refreshUserAccessToken(
  input: RefreshUserAccessTokenInput,
): Promise<PluginStoredTokens> {
  const clientId = requireEnv(input.clientIdEnv);
  const clientSecret = requireEnv(input.clientSecretEnv);
  const request = buildOAuthTokenRequest({
    clientId,
    clientSecret,
    payload: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    },
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(USER_REFRESH_TIMEOUT_MS),
  });
  const responseText = await response.text();
  const responseData = parseOAuthResponseJson(responseText);
  const errorCode = oauthErrorCode(responseData);
  if (isRejectedRefreshError(errorCode)) {
    throw new GitHubUserRefreshRejectedError(
      `GitHub user token refresh rejected: ${errorCode}`,
    );
  }
  if (!response.ok || errorCode) {
    throw new Error(
      `GitHub user token refresh failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`,
    );
  }
  try {
    return parseOAuthTokenResponse(responseData, input.requestedScope);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "OAuth token response missing access_token"
    ) {
      throw new GitHubUserRefreshRejectedError(error.message);
    }
    throw error;
  }
}

function leaseExpiry(expiresAt?: number): number {
  return expiresAt
    ? Math.min(expiresAt, Date.now() + MAX_LEASE_MS)
    : Date.now() + MAX_LEASE_MS;
}

function isGitSmartHttpDomain(domain: string): boolean {
  return domain.toLowerCase() === "github.com";
}

function authorizationFor(domain: string, token: string): string {
  if (isGitSmartHttpDomain(domain)) {
    return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return `Bearer ${token}`;
}

function createCredentialLease(
  input: CredentialLeaseInput,
): PluginCredentialResult {
  return {
    type: "lease",
    lease: {
      ...(input.account ? { account: input.account } : undefined),
      ...(input.authorization ? { authorization: input.authorization } : undefined),
      expiresAt: new Date(input.expiresAtMs).toISOString(),
      headerTransforms: (
        input.domains ??
        (input.authorization
          ? GITHUB_ASSET_UPLOAD_CREDENTIAL_DOMAINS
          : GITHUB_CREDENTIAL_DOMAINS)
      ).map((domain) => ({
        domain,
        headers: {
          Authorization: authorizationFor(domain, input.token),
        },
      })),
    },
  };
}

function githubUserAuthorization(
  scope?: string,
): CredentialLeaseInput["authorization"] {
  return {
    type: "oauth",
    provider: "github",
    ...(scope ? { scope } : undefined),
  };
}

function credentialNeeded(
  message: string,
  scope?: string,
  allowAuthorization = true,
): PluginCredentialResult {
  return {
    type: "needed",
    message,
    ...(allowAuthorization
      ? { authorization: githubUserAuthorization(scope) }
      : undefined),
  };
}

/** Return a credential result for invalid GitHub App configuration. */
export function credentialUnavailable(message: string): PluginCredentialResult {
  return {
    type: "unavailable",
    message,
  };
}

function parseInstallationTokenResponse(data: unknown): {
  expiresAtMs: number;
  token: string;
} {
  if (!isRecord(data)) {
    throw new Error("GitHub installation token response is invalid");
  }
  const token = data.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("GitHub installation token response missing token");
  }
  const expiresAt = data.expires_at;
  const expiresAtMs =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error(
      "GitHub installation token response returned invalid expires_at",
    );
  }
  return { token, expiresAtMs };
}

function readInstallationPermissions(
  installation: unknown,
): Record<string, "read"> {
  if (!isRecord(installation) || !isRecord(installation.permissions)) {
    throw new Error("GitHub installation response missing permissions");
  }
  return readGrantPermissions(installation.permissions);
}

function decodeGitHubPathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !decoded.includes("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a GitHub repository from an API or Git URL. */
export function githubRepositoryFromUrl(
  upstreamUrl: URL,
): GitHubRepository | undefined {
  const segments = upstreamUrl.pathname.split("/").filter(Boolean);
  if (isGitHubApiUrl(upstreamUrl) && segments[0]?.toLowerCase() === "repos") {
    const owner = segments[1]
      ? decodeGitHubPathSegment(segments[1])
      : undefined;
    const name = segments[2] ? decodeGitHubPathSegment(segments[2]) : undefined;
    return owner && name ? { owner, name } : undefined;
  }
  if (upstreamUrl.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const owner = segments[0] ? decodeGitHubPathSegment(segments[0]) : undefined;
  const rawName = segments[1]?.replace(/\.git$/i, "");
  const name = rawName ? decodeGitHubPathSegment(rawName) : undefined;
  return owner && name ? { owner, name } : undefined;
}

/** Resolve the GitHub account associated with stored user tokens. */
export async function resolveUserAccount(
  tokens: PluginStoredTokens,
): Promise<PluginProviderAccount> {
  const account = await githubRequest("https://api.github.com", "/user", {
    token: tokens.accessToken,
  });
  if (!isRecord(account)) {
    throw new Error("GitHub user response is invalid");
  }
  const id = account.id;
  const login = account.login;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    typeof login !== "string" ||
    !login.trim()
  ) {
    throw new Error("GitHub user response missing id or login");
  }
  const url =
    typeof account.html_url === "string" ? account.html_url : undefined;
  return {
    handle: login.trim(),
    id: String(id),
    label: login.trim(),
    ...(url ? { url } : undefined),
  };
}

async function tokensWithAccount(
  tokenSlot: PluginUserTokenSlot,
  stored: PluginStoredTokens,
  scope?: string,
): Promise<TokenResolution> {
  if (stored.account) {
    return { ok: true, tokens: stored };
  }
  let account;
  try {
    account = await resolveUserAccount(stored);
  } catch (error) {
    if (
      error instanceof GitHubRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope,
        ),
      };
    }
    throw error;
  }
  const updated = { ...stored, account };
  await tokenSlot.set(updated);
  return { ok: true, tokens: updated };
}

function shouldRefreshUserToken(
  stored: PluginStoredTokens,
  now = Date.now(),
): boolean {
  return (
    stored.expiresAt !== undefined && stored.expiresAt - now < REFRESH_BUFFER_MS
  );
}

function canUseStoredUserToken(stored: PluginStoredTokens): boolean {
  return (
    stored.expiresAt === undefined ||
    (stored.expiresAt > Date.now() && !shouldRefreshUserToken(stored))
  );
}

/** Re-read under the token-slot refresh gate so concurrent callers reuse the winner's rotated tokens. */
async function refreshUserTokensWithLock(
  tokenSlot: PluginUserTokenSlot,
  scope: string | undefined,
  options: UserCredentialOptions,
): Promise<TokenResolution> {
  return await tokenSlot.withRefresh(async () => {
    const latest = await tokenSlot.get();
    if (!latest) {
      return {
        ok: false,
        result: credentialNeeded("Connect your GitHub account.", scope),
      };
    }
    if (!hasRequiredOAuthScope(latest.scope, scope)) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope,
        ),
      };
    }
    if (canUseStoredUserToken(latest)) {
      return { ok: true, tokens: latest };
    }

    let refreshed;
    try {
      refreshed = await refreshUserAccessToken({
        clientIdEnv: options.clientIdEnv,
        clientSecretEnv: options.clientSecretEnv,
        refreshToken: latest.refreshToken,
        requestedScope: latest.scope ?? scope,
      });
    } catch (error) {
      if (!(error instanceof GitHubUserRefreshRejectedError)) {
        throw error;
      }
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization has expired.",
          scope,
        ),
      };
    }
    if (!hasRequiredOAuthScope(refreshed.scope, scope)) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope,
        ),
      };
    }
    const refreshedTokens = {
      ...(latest.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: latest.refreshTokenExpiresAt }
        : undefined),
      ...refreshed,
      ...(latest.account ? { account: latest.account } : undefined),
    };
    await tokenSlot.set(refreshedTokens);
    return { ok: true, tokens: refreshedTokens };
  });
}

/** Issue a bounded GitHub user credential for an approved grant. */
export async function issueUserCredential(
  ctx: IssueCredentialHookContext,
  options: UserCredentialOptions,
): Promise<PluginCredentialResult> {
  const scope = options.userScope;
  const tokenSlot = ctx.tokens.currentUser ?? ctx.tokens.credentialSubject;
  if (!tokenSlot) {
    return credentialNeeded(
      "GitHub write access requires a current user or delegated user credential subject.",
      scope,
      false,
    );
  }

  const stored = await tokenSlot.get();
  if (!stored) {
    return credentialNeeded(
      "GitHub write access requires user authorization.",
      scope,
    );
  }
  if (!hasRequiredOAuthScope(stored.scope, scope)) {
    return credentialNeeded(
      "Your GitHub authorization needs to be refreshed.",
      scope,
    );
  }

  const now = Date.now();
  if (
    stored.expiresAt !== undefined &&
    stored.expiresAt - now < REFRESH_BUFFER_MS
  ) {
    const refreshResult = await refreshUserTokensWithLock(
      tokenSlot,
      scope,
      options,
    );
    if (!refreshResult.ok) {
      return refreshResult.result;
    }
    const withAccount = await tokensWithAccount(
      tokenSlot,
      refreshResult.tokens,
      scope,
    );
    if (!withAccount.ok) {
      return withAccount.result;
    }
    return createCredentialLease({
      account: withAccount.tokens.account,
      token: withAccount.tokens.accessToken,
      expiresAtMs: leaseExpiry(withAccount.tokens.expiresAt),
      authorization: githubUserAuthorization(scope),
    });
  }

  if (stored.expiresAt === undefined || stored.expiresAt > Date.now()) {
    const withAccount = await tokensWithAccount(tokenSlot, stored, scope);
    if (!withAccount.ok) {
      return withAccount.result;
    }
    return createCredentialLease({
      account: withAccount.tokens.account,
      token: withAccount.tokens.accessToken,
      expiresAtMs: leaseExpiry(withAccount.tokens.expiresAt),
      authorization: githubUserAuthorization(scope),
    });
  }

  return credentialNeeded("Your GitHub authorization has expired.", scope);
}

/** Issue a bounded raw token for plugin-owned GitHub API calls. */
export async function issueInstallationToken(
  options: InstallationCredentialOptions,
): Promise<{ expiresAtMs: number; token: string }> {
  const appId = requireEnv(options.appIdEnv);
  const installationIdRaw = requireEnv(options.installationIdEnv);
  const installationId = Number(installationIdRaw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GitHubPluginSetupError(`Invalid ${options.installationIdEnv}`);
  }

  const appJwt = createAppJwt(appId, options.privateKeyEnv);
  const permissions =
    "permissions" in options
      ? options.permissions
      : typeof options.loadPermissions === "function"
        ? await options.loadPermissions({ appJwt, installationId })
        : undefined;
  const repositories =
    "repositories" in options ? options.repositories : undefined;
  const body = {
    ...(permissions ? { permissions } : undefined),
    ...(repositories ? { repositories } : undefined),
  };
  const accessTokenResponse = await githubRequest(
    "https://api.github.com",
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: appJwt,
      body,
    },
  );
  const parsedToken = parseInstallationTokenResponse(accessTokenResponse);
  return {
    expiresAtMs: Math.min(parsedToken.expiresAtMs, Date.now() + MAX_LEASE_MS),
    token: parsedToken.token,
  };
}

/** Issue a bounded GitHub App installation credential. */
export async function issueInstallationCredential(
  options: InstallationCredentialOptions,
): Promise<PluginCredentialResult> {
  const token = await issueInstallationToken(options);
  return createCredentialLease({
    token: token.token,
    expiresAtMs: token.expiresAtMs,
  });
}

/** Cache the installation's read permissions for one lease period. */
export function createPermissionCache(): LoadInstallationReadPermissions {
  let cached:
    | {
        expiresAtMs: number;
        permissions: Record<string, "read">;
      }
    | undefined;
  let pending: Promise<Record<string, "read">> | undefined;
  return async ({ appJwt, installationId }) => {
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.permissions;
    }
    pending ??= githubRequest(
      "https://api.github.com",
      `/app/installations/${installationId}`,
      { token: appJwt },
    )
      .then((installation) => {
        const permissions = readInstallationPermissions(installation);
        cached = {
          expiresAtMs: Date.now() + MAX_LEASE_MS,
          permissions,
        };
        return permissions;
      })
      .finally(() => {
        pending = undefined;
      });
    return await pending;
  };
}
