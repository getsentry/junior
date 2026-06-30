/**
 * GitHub plugin runtime boundary.
 *
 * This package owns GitHub App credentials, egress grant selection, sandbox git
 * preparation, and runtime tools. Host egress injects provider credentials; the
 * plugin builds provider requests and enforces GitHub-specific command policy.
 */
import { createPrivateKey, createSign } from "node:crypto";
import {
  defineJuniorPlugin,
  EgressPolicyDenied,
  type EgressHookContext,
  type EgressResponseHookContext,
  type IssueCredentialHookContext,
  type PluginCredentialResult,
  type PluginGrant,
  type PluginGrantAccess,
  type PluginProviderAccount,
  type PluginRegistration,
  type PluginStoredTokens,
  type PluginUserTokenSlot,
  type Requester,
  type SandboxPrepareHookContext,
} from "@sentry/junior-plugin-api";
import {
  type GitHubAppPermissions,
  normalizePermissions,
  permissionCapabilities,
  readGrantPermissions,
} from "./permissions.js";
import { createGitHubTools } from "./tools.js";

export type { GitHubAppPermissionLevel } from "./permissions.js";

/** Configure the built-in GitHub plugin manifest and hooks. */
export interface GitHubPluginOptions {
  /**
   * Extra OAuth `scope` values to request during GitHub App user authorization.
   *
   * GitHub App user tokens report empty scopes, so Junior treats this as a
   * local reauthorization contract only. Effective access still comes from the
   * app permissions, installation repositories, and requesting user's access.
   */
  additionalUserScopes?: string[];

  /**
   * GitHub App installation permissions Junior should request for app tokens.
   *
   * Keys may use GitHub permission names with underscores or hyphens. Junior
   * records these as plugin capabilities and requests read-only installation
   * tokens by scoping read-capable permissions down to `read`.
   * GitHub remains the source of truth for whether a permission exists.
   */
  appPermissions?: GitHubAppPermissions;

  /** Environment variable containing the GitHub App id. */
  appIdEnv?: string;

  /** Environment variable containing Junior's Git committer email. */
  botEmailEnv?: string;

  /** Environment variable containing Junior's Git committer name. */
  botNameEnv?: string;

  /** Environment variable containing the GitHub App OAuth client id. */
  clientIdEnv?: string;

  /** Environment variable containing the GitHub App OAuth client secret. */
  clientSecretEnv?: string;

  /** Environment variable containing the GitHub App installation id. */
  installationIdEnv?: string;

  /** Environment variable containing the GitHub App private key. */
  privateKeyEnv?: string;
}

type JsonRecord = Record<string, unknown>;
type GitHubGrantName = "installation-read" | "user-read" | "user-write";
type GitHubGrantReason =
  | "github.api-read"
  | "github.api-write"
  | "github.contents-write"
  | "github.fork-create"
  | "github.git-read"
  | "github.git-write"
  | "github.graphql-read"
  | "github.graphql-write"
  | "github.issue-create"
  | "github.issues-write"
  | "github.pull-create"
  | "github.pull-requests-write"
  | "github.user-read"
  | "github.workflows-write";
type GitHubGrant = PluginGrant & {
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

interface InstallationCredentialOptions {
  appIdEnv: string;
  installationIdEnv: string;
  loadReadPermissions(input: {
    appJwt: string;
    installationId: number;
  }): Promise<Record<string, "read">>;
  privateKeyEnv: string;
  readPermissions?: Record<string, "read">;
}

const GITHUB_APP_ID_ENV = "GITHUB_APP_ID";
const GITHUB_APP_PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY";
const GITHUB_INSTALLATION_ID_ENV = "GITHUB_INSTALLATION_ID";
const GITHUB_AUTH_TOKEN_ENV = "GITHUB_TOKEN";
const GITHUB_AUTH_TOKEN_PLACEHOLDER = "ghp_host_managed_credential";
const MAX_LEASE_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const USER_REFRESH_TIMEOUT_MS = 20_000;
const GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const USER_TOKEN_GRANTS = new Set(["user-read", "user-write"]);
const CONTENTS_WRITE_REQUIREMENTS = [
  "GitHub App Contents: write on the target repository",
  "requesting GitHub user write access to the repository",
];
const WORKFLOWS_WRITE_REQUIREMENTS = [
  "GitHub App Contents: write and Workflows: write on the target repository",
  "requesting GitHub user write access to the repository",
];
const ISSUES_WRITE_REQUIREMENTS = [
  "GitHub App Issues: write on the target repository",
  "requesting GitHub user issue access to the repository",
];
const PULL_REQUESTS_WRITE_REQUIREMENTS = [
  "GitHub App Pull requests: write on the target repository",
  "requesting GitHub user write access to the repository",
];
const FORK_CREATE_REQUIREMENTS = [
  "GitHub App Administration: write and Contents: read",
  "app installation access on the source and destination accounts",
  "requesting GitHub user permission to fork the repository",
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

class GitHubPluginSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPluginSetupError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new GitHubPluginSetupError(`Missing ${name}`);
  }
  return value;
}

function normalizeScopeList(scopes?: string[]): string[] {
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

function cleanIdentityPart(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replace(/[<>]/g, "")
    .trim();
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{5,}$/.test(value);
}

function requesterDisplayName(
  value: unknown,
  requester?: Requester,
): string | undefined {
  const name = cleanIdentityPart(value);
  if (
    !name ||
    name.toLowerCase() === "unknown" ||
    name === cleanIdentityPart(requester?.userId)
  ) {
    return undefined;
  }
  return isSlackUserId(name) ? undefined : name;
}

function requesterName(requester?: Requester): string | undefined {
  return (
    requesterDisplayName(requester?.fullName, requester) ||
    requesterDisplayName(requester?.userName, requester) ||
    undefined
  );
}

function requesterEmail(requester?: Requester): string | undefined {
  const email = cleanIdentityPart(requester?.email);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

function isGitCommitCommand(command: string): boolean {
  return /(?:^|[\s;|&])git(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)))*\s+commit(?:\s|$)/.test(
    command,
  );
}

function prepareCommitMsgHook(): string {
  return `#!/usr/bin/env bash
set -eu

message_file="\${1:-}"
if [ -z "$message_file" ]; then
  exit 1
fi

if [ -z "\${JUNIOR_GIT_AUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_AUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: requester commit attribution was not injected by the host runtime. Do not set Git author env vars manually; report this configuration error." >&2
  exit 1
fi

if [ "\${GIT_AUTHOR_NAME:-}" != "$JUNIOR_GIT_AUTHOR_NAME" ] || [ "\${GIT_AUTHOR_EMAIL:-}" != "$JUNIOR_GIT_AUTHOR_EMAIL" ]; then
  echo "Junior GitHub plugin internal error: Git author was not set to the resolved requester identity. Do not override Git author manually; report this configuration error." >&2
  exit 1
fi

if [ -z "\${JUNIOR_GIT_COAUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_COAUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: Junior coauthor identity was not injected by the host runtime. Do not set coauthor env vars manually; report this configuration error." >&2
  exit 1
fi

trailer="Co-Authored-By: $JUNIOR_GIT_COAUTHOR_NAME <$JUNIOR_GIT_COAUTHOR_EMAIL>"
if grep -Fqx "$trailer" "$message_file"; then
  exit 0
fi

printf '\\n%s\\n' "$trailer" >> "$message_file"
`;
}

async function configureGit(
  ctx: SandboxPrepareHookContext,
  key: string,
  value: string,
): Promise<void> {
  const result = await ctx.sandbox.run({
    cmd: "git",
    args: ["config", "--global", key, value],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to configure git ${key}: ${result.stderr || result.stdout}`,
    );
  }
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

async function githubRequest(
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
      ...(params.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
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
    ...(scope ? { scope } : {}),
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
      ...(input.account ? { account: input.account } : {}),
      ...(input.authorization ? { authorization: input.authorization } : {}),
      expiresAt: new Date(input.expiresAtMs).toISOString(),
      headerTransforms: ["api.github.com", "github.com"].map((domain) => ({
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
    ...(scope ? { scope } : {}),
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
      : {}),
  };
}

function credentialUnavailable(message: string): PluginCredentialResult {
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

async function resolveUserAccount(
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
    id: String(id),
    label: login.trim(),
    ...(url ? { url } : {}),
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
        : {}),
      ...refreshed,
      ...(latest.account ? { account: latest.account } : {}),
    };
    await tokenSlot.set(refreshedTokens);
    return { ok: true, tokens: refreshedTokens };
  });
}

async function issueUserCredential(
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

async function issueInstallationCredential(
  options: InstallationCredentialOptions,
): Promise<PluginCredentialResult> {
  const appId = requireEnv(options.appIdEnv);
  const installationIdRaw = requireEnv(options.installationIdEnv);
  const installationId = Number(installationIdRaw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GitHubPluginSetupError(`Invalid ${options.installationIdEnv}`);
  }

  const appJwt = createAppJwt(appId, options.privateKeyEnv);
  let tokenPermissions = options.readPermissions;
  if (!tokenPermissions) {
    tokenPermissions = await options.loadReadPermissions({
      appJwt,
      installationId,
    });
  }

  const accessTokenResponse = await githubRequest(
    "https://api.github.com",
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: appJwt,
      body: { permissions: tokenPermissions },
    },
  );
  const parsedToken = parseInstallationTokenResponse(accessTokenResponse);
  const expiresAtMs = Math.min(
    parsedToken.expiresAtMs,
    Date.now() + MAX_LEASE_MS,
  );
  return createCredentialLease({
    token: parsedToken.token,
    expiresAtMs,
  });
}

function createPermissionCache(): InstallationCredentialOptions["loadReadPermissions"] {
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

function githubSmartHttpAccess(
  upstreamUrl: URL,
): PluginGrantAccess | undefined {
  const pathname = upstreamUrl.pathname.toLowerCase();
  const service = upstreamUrl.searchParams.get("service")?.toLowerCase();
  const isSmartHttpPath =
    pathname.endsWith("/info/refs") ||
    pathname.endsWith("/git-receive-pack") ||
    pathname.endsWith("/git-upload-pack");
  if (!isSmartHttpPath) {
    return undefined;
  }
  if (
    pathname.endsWith("/git-receive-pack") ||
    service === "git-receive-pack"
  ) {
    return "write";
  }
  if (pathname.endsWith("/git-upload-pack") || service === "git-upload-pack") {
    return "read";
  }
  return undefined;
}

function isGitHubGraphqlUrl(upstreamUrl: URL): boolean {
  return (
    upstreamUrl.hostname.toLowerCase() === "api.github.com" &&
    upstreamUrl.pathname.toLowerCase().endsWith("/graphql")
  );
}

function isGitHubApiUrl(upstreamUrl: URL): boolean {
  return upstreamUrl.hostname.toLowerCase() === "api.github.com";
}

function githubUserReadReason(
  method: string,
  upstreamUrl: URL,
): GitHubGrantReason | undefined {
  if (method !== "GET" || !isGitHubApiUrl(upstreamUrl)) {
    return undefined;
  }
  return upstreamUrl.pathname.toLowerCase() === "/user"
    ? "github.user-read"
    : undefined;
}

function parseGitHubGraphqlOperation(
  bodyText: string | undefined,
): PluginGrantAccess | undefined {
  const parsed = parseGitHubGraphqlRequest(bodyText);
  if (!parsed) {
    return undefined;
  }
  const { normalized, operationName } = parsed;
  if (operationName) {
    const namedOperation = normalized.match(
      new RegExp(
        `\\b(query|mutation|subscription)\\s+${escapeRegExp(operationName)}\\b`,
      ),
    )?.[1];
    return namedOperation ? graphqlOperationAccess(namedOperation) : undefined;
  }
  const operation = normalized.match(/\b(query|mutation|subscription)\b/)?.[1];
  const operationAccess = graphqlOperationAccess(operation);
  if (operationAccess) {
    return operationAccess;
  }
  if (normalized.startsWith("{")) {
    return "read";
  }
  return undefined;
}

function parseGitHubGraphqlRequest(
  bodyText: string | undefined,
): { normalized: string; operationName?: string } | undefined {
  if (typeof bodyText !== "string" || bodyText.trim().length === 0) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const query = parsed.query;
  if (typeof query !== "string") {
    return undefined;
  }
  const operationName =
    typeof parsed.operationName === "string"
      ? parsed.operationName.trim()
      : undefined;
  const normalized = maskGraphqlStringLiterals(
    query.replace(/^\s*#[^\n\r]*(?:\r?\n|$)/gm, ""),
  ).trim();
  return {
    normalized,
    ...(operationName ? { operationName } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function graphqlOperationAccess(
  operation: string | undefined,
): PluginGrantAccess | undefined {
  if (operation === "mutation" || operation === "subscription") {
    return "write";
  }
  if (operation === "query") {
    return "read";
  }
  return undefined;
}

function maskGraphqlStringLiterals(query: string): string {
  return query.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g, (match) =>
    " ".repeat(match.length),
  );
}

function githubGraphqlAccess(
  method: string,
  upstreamUrl: URL,
  bodyText: string | undefined,
): PluginGrantAccess | undefined {
  if (!isGitHubGraphqlUrl(upstreamUrl)) {
    return undefined;
  }
  if (HTTP_READ_METHODS.has(method)) {
    return "read";
  }
  const operation = parseGitHubGraphqlOperation(bodyText);
  if (operation) {
    return operation;
  }
  // Unknown GraphQL POST bodies still require user-write attribution rather
  // than risking an unattributed mutation through an installation-read token.
  return "write";
}

function githubGraphqlPermissionDeniedMessage(
  bodyText: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) {
    return undefined;
  }
  for (const error of parsed.errors) {
    if (!isRecord(error) || typeof error.message !== "string") {
      continue;
    }
    const message = error.message;
    if (
      error.type === "NOT_FOUND" &&
      /\bCould not resolve to a Repository with the name\b/.test(message)
    ) {
      return `GitHub GraphQL could not access the repository: ${message}`;
    }
    if (/\bResource not accessible by integration\b/.test(message)) {
      return `GitHub GraphQL denied access: ${message}`;
    }
  }
  return undefined;
}

function shouldInspectGitHubGraphqlResponse(
  ctx: EgressResponseHookContext,
): boolean {
  if (
    ctx.request.method.toUpperCase() !== "POST" ||
    ctx.response.status !== 200
  ) {
    return false;
  }
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(ctx.request.url);
  } catch {
    return false;
  }
  if (!isGitHubGraphqlUrl(upstreamUrl)) {
    return false;
  }
  const contentType = ctx.response.headers.get("content-type");
  return contentType ? /\bjson\b/i.test(contentType) : false;
}

function githubApiWriteReason(
  method: string,
  upstreamUrl: URL,
): GitHubGrantReason | undefined {
  const pathname = upstreamUrl.pathname.toLowerCase();
  if (!isGitHubApiUrl(upstreamUrl)) {
    return undefined;
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(pathname)) {
    return "github.issue-create";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/.test(pathname)
  ) {
    return "github.issues-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(pathname)) {
    return "github.pull-create";
  }
  if (
    method === "PATCH" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/.test(pathname)
  ) {
    return "github.pull-requests-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/forks$/.test(pathname)) {
    return "github.fork-create";
  }
  if (
    /^\/repos\/[^/]+\/[^/]+\/contents(?:\/|$)/.test(pathname) &&
    (method === "PUT" || method === "DELETE")
  ) {
    return pathname.includes("/.github/workflows/")
      ? "github.workflows-write"
      : "github.contents-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits)$/.test(pathname)
  ) {
    return "github.contents-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(pathname)
  ) {
    return "github.contents-write";
  }
  if (
    (method === "PATCH" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+/.test(pathname)
  ) {
    return "github.contents-write";
  }
  if (
    method === "PUT" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(pathname)
  ) {
    return "github.contents-write";
  }
  return undefined;
}

function isGitHubIssueCreateRestRequest(
  method: string,
  upstreamUrl: URL,
): boolean {
  return (
    method === "POST" &&
    isGitHubApiUrl(upstreamUrl) &&
    /^\/repos\/[^/]+\/[^/]+\/issues$/.test(upstreamUrl.pathname.toLowerCase())
  );
}

function isGitHubPullCreateRestRequest(
  method: string,
  upstreamUrl: URL,
): boolean {
  return (
    method === "POST" &&
    isGitHubApiUrl(upstreamUrl) &&
    /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(upstreamUrl.pathname.toLowerCase())
  );
}

function isGitHubIssueCreateGraphqlMutation(
  method: string,
  upstreamUrl: URL,
  bodyText: string | undefined,
): boolean {
  if (method !== "POST" || !isGitHubGraphqlUrl(upstreamUrl)) {
    return false;
  }
  const parsed = parseGitHubGraphqlRequest(bodyText);
  if (!parsed) {
    return false;
  }
  if (!/\bcreateIssue\b/.test(parsed.normalized)) {
    return false;
  }
  if (!parsed.operationName) {
    return /\bmutation\b/.test(parsed.normalized);
  }
  return new RegExp(
    `\\bmutation\\s+${escapeRegExp(parsed.operationName)}\\b`,
  ).test(parsed.normalized);
}

function isGitHubPullCreateGraphqlMutation(
  method: string,
  upstreamUrl: URL,
  bodyText: string | undefined,
): boolean {
  if (method !== "POST" || !isGitHubGraphqlUrl(upstreamUrl)) {
    return false;
  }
  const parsed = parseGitHubGraphqlRequest(bodyText);
  if (!parsed) {
    return false;
  }
  if (!/\bcreatePullRequest\b/.test(parsed.normalized)) {
    return false;
  }
  if (!parsed.operationName) {
    return /\bmutation\b/.test(parsed.normalized);
  }
  return new RegExp(
    `\\bmutation\\s+${escapeRegExp(parsed.operationName)}\\b`,
  ).test(parsed.normalized);
}

function assertGitHubWriteAllowed(input: {
  bodyText?: string;
  method: string;
  operation?: string;
  upstreamUrl: URL;
}): void {
  if (input.operation === "github.issue.create") {
    return;
  }
  if (input.operation === "github.pull.create") {
    return;
  }
  if (
    isGitHubIssueCreateRestRequest(input.method, input.upstreamUrl) ||
    isGitHubIssueCreateGraphqlMutation(
      input.method,
      input.upstreamUrl,
      input.bodyText,
    )
  ) {
    throw new EgressPolicyDenied(
      "GitHub issue creation must use the github_createIssue tool so Junior can own idempotency and the conversation footer.",
    );
  }
  if (
    isGitHubPullCreateRestRequest(input.method, input.upstreamUrl) ||
    isGitHubPullCreateGraphqlMutation(
      input.method,
      input.upstreamUrl,
      input.bodyText,
    )
  ) {
    throw new EgressPolicyDenied(
      "GitHub pull request creation must use the github_createPullRequest tool so Junior can own idempotency and the conversation footer.",
    );
  }
}

function grantRequirements(reason: GitHubGrantReason): string[] | undefined {
  if (reason === "github.git-write" || reason === "github.contents-write") {
    return CONTENTS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.workflows-write") {
    return WORKFLOWS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.issue-create" || reason === "github.issues-write") {
    return ISSUES_WRITE_REQUIREMENTS;
  }
  if (
    reason === "github.pull-create" ||
    reason === "github.pull-requests-write"
  ) {
    return PULL_REQUESTS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.fork-create") {
    return FORK_CREATE_REQUIREMENTS;
  }
  return undefined;
}

function grantForAccess(
  access: PluginGrantAccess,
  reason: GitHubGrantReason,
  name: GitHubGrantName,
): GitHubGrant {
  const requirements = grantRequirements(reason);
  return {
    name,
    access,
    reason,
    ...(requirements ? { requirements } : {}),
  };
}

async function githubGrantForEgress(
  ctx: EgressHookContext,
): Promise<GitHubGrant> {
  const method = ctx.request.method.toUpperCase();
  const upstreamUrl = new URL(ctx.request.url);
  assertGitHubWriteAllowed({
    ...(ctx.request.bodyText !== undefined
      ? { bodyText: ctx.request.bodyText }
      : {}),
    method,
    ...(ctx.request.operation ? { operation: ctx.request.operation } : {}),
    upstreamUrl,
  });
  const smartHttpAccess = githubSmartHttpAccess(upstreamUrl);
  if (smartHttpAccess) {
    return grantForAccess(
      smartHttpAccess,
      smartHttpAccess === "write" ? "github.git-write" : "github.git-read",
      smartHttpAccess === "write" ? "user-write" : "installation-read",
    );
  }

  const userReadReason = githubUserReadReason(method, upstreamUrl);
  if (userReadReason) {
    return grantForAccess("read", userReadReason, "user-read");
  }

  const writeReason = githubApiWriteReason(method, upstreamUrl);
  if (writeReason) {
    return grantForAccess("write", writeReason, "user-write");
  }

  const graphqlAccess = githubGraphqlAccess(
    method,
    upstreamUrl,
    ctx.request.bodyText,
  );
  if (graphqlAccess) {
    return grantForAccess(
      graphqlAccess,
      graphqlAccess === "write"
        ? "github.graphql-write"
        : "github.graphql-read",
      graphqlAccess === "write" ? "user-write" : "installation-read",
    );
  }

  const access = HTTP_READ_METHODS.has(method) ? "read" : "write";
  return grantForAccess(
    access,
    access === "write" ? "github.api-write" : "github.api-read",
    access === "write" ? "user-write" : "installation-read",
  );
}

/** Register GitHub runtime hooks for repository workflows. */
export function githubPlugin(
  options: GitHubPluginOptions = {},
): PluginRegistration {
  const botNameEnv = options.botNameEnv ?? "GITHUB_APP_BOT_NAME";
  const botEmailEnv = options.botEmailEnv ?? "GITHUB_APP_BOT_EMAIL";
  const clientIdEnv = options.clientIdEnv ?? "GITHUB_APP_CLIENT_ID";
  const clientSecretEnv = options.clientSecretEnv ?? "GITHUB_APP_CLIENT_SECRET";
  const appIdEnv = options.appIdEnv ?? GITHUB_APP_ID_ENV;
  const privateKeyEnv = options.privateKeyEnv ?? GITHUB_APP_PRIVATE_KEY_ENV;
  const installationIdEnv =
    options.installationIdEnv ?? GITHUB_INSTALLATION_ID_ENV;
  const appPermissions = normalizePermissions(options.appPermissions);
  const appReadPermissions = appPermissions
    ? readGrantPermissions(appPermissions)
    : undefined;
  const loadReadPermissions = createPermissionCache();
  const appCapabilities = permissionCapabilities(appPermissions);
  const userScopes = normalizeScopeList(options.additionalUserScopes);
  const userScope = userScopes.length ? userScopes.join(" ") : undefined;

  return defineJuniorPlugin({
    packageName: "@sentry/junior-github",
    manifest: {
      name: "github",
      displayName: "GitHub",
      description:
        "GitHub issue, pull request, and repository workflows via GitHub App",
      ...(appCapabilities ? { capabilities: appCapabilities } : {}),
      configKeys: ["org", "repo"],
      domains: ["api.github.com", "github.com"],
      envVars: {
        [appIdEnv]: {},
        [privateKeyEnv]: {},
        [installationIdEnv]: {},
        [clientIdEnv]: {},
        [clientSecretEnv]: {},
        [botNameEnv]: { exposeToCommandEnv: true },
        [botEmailEnv]: { exposeToCommandEnv: true },
      },
      oauth: {
        clientIdEnv,
        clientSecretEnv,
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        // GitHub App user-to-server tokens always return scope: "" regardless
        // of what was requested; treat empty response scope as unreported.
        treatEmptyScopeAsUnreported: true,
        ...(userScope ? { scope: userScope } : {}),
      },
      commandEnv: {
        [GITHUB_AUTH_TOKEN_ENV]: GITHUB_AUTH_TOKEN_PLACEHOLDER,
        GIT_COMMITTER_NAME: `\${${botNameEnv}}`,
        GIT_COMMITTER_EMAIL: `\${${botEmailEnv}}`,
      },
      target: {
        type: "repo",
        configKey: "repo",
        commandFlags: ["--repo", "-R"],
      },
      runtimeDependencies: [
        {
          type: "system",
          package: "gh",
        },
      ],
    },
    hooks: {
      tools(ctx) {
        return createGitHubTools(ctx);
      },
      async sandboxPrepare(ctx) {
        const hooksPath = `${ctx.sandbox.juniorRoot}/git-hooks`;
        await ctx.sandbox.writeFile({
          path: `${hooksPath}/prepare-commit-msg`,
          mode: 0o755,
          content: prepareCommitMsgHook(),
        });
        await configureGit(ctx, "core.hooksPath", hooksPath);
        await configureGit(ctx, "commit.gpgsign", "false");
        await configureGit(ctx, "credential.helper", "");
        await configureGit(ctx, "http.emptyAuth", "true");
      },
      beforeToolExecute(ctx) {
        if (ctx.tool.name !== "bash") {
          return;
        }
        const command =
          typeof ctx.tool.input === "object" &&
          ctx.tool.input &&
          "command" in ctx.tool.input
            ? String(ctx.tool.input.command ?? "")
            : "";
        const botName = readEnv(botNameEnv);
        const botEmail = readEnv(botEmailEnv);
        if ((!botName || !botEmail) && isGitCommitCommand(command)) {
          ctx.decision.deny(
            `Junior GitHub plugin is misconfigured: host env vars ${botNameEnv} and ${botEmailEnv} are missing. This is an internal deployment configuration error; do not set them in the sandbox.`,
          );
          return;
        }
        if (!botName || !botEmail) {
          return;
        }
        const authorName = requesterName(ctx.requester);
        const authorEmail = requesterEmail(ctx.requester);
        if ((!authorName || !authorEmail) && isGitCommitCommand(command)) {
          ctx.decision.deny(
            "Junior GitHub plugin could not determine a resolved requester name and email for commit attribution. This is an internal request-context error; do not set author env vars manually.",
          );
          return;
        }
        if (authorName && authorEmail) {
          ctx.env.set("GIT_AUTHOR_NAME", authorName);
          ctx.env.set("GIT_AUTHOR_EMAIL", authorEmail);
          ctx.env.set("JUNIOR_GIT_AUTHOR_NAME", authorName);
          ctx.env.set("JUNIOR_GIT_AUTHOR_EMAIL", authorEmail);
        }
        ctx.env.set("GIT_COMMITTER_NAME", botName);
        ctx.env.set("GIT_COMMITTER_EMAIL", botEmail);
        ctx.env.set("JUNIOR_GIT_COAUTHOR_NAME", botName);
        ctx.env.set("JUNIOR_GIT_COAUTHOR_EMAIL", botEmail);
      },
      grantForEgress(ctx) {
        return githubGrantForEgress(ctx);
      },
      async onEgressResponse(ctx) {
        if (!shouldInspectGitHubGraphqlResponse(ctx)) {
          return;
        }
        const bodyText = await ctx.response.readText(
          GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
        );
        if (!bodyText) {
          return;
        }
        const message = githubGraphqlPermissionDeniedMessage(bodyText);
        if (message) {
          ctx.permissionDenied(message);
        }
      },
      async resolveOAuthAccount(ctx) {
        return await resolveUserAccount(ctx.tokens);
      },
      async issueCredential(ctx) {
        try {
          if (ctx.grant.name === "installation-read") {
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
              readPermissions: appReadPermissions,
              loadReadPermissions,
            });
          }
          if (USER_TOKEN_GRANTS.has(ctx.grant.name)) {
            return await issueUserCredential(ctx, {
              clientIdEnv,
              clientSecretEnv,
              userScope,
            });
          }
        } catch (error) {
          if (error instanceof GitHubPluginSetupError) {
            return credentialUnavailable(error.message);
          }
          throw error;
        }
        throw new Error(
          `GitHub plugin cannot issue unknown grant "${ctx.grant.name}".`,
        );
      },
    },
  });
}
