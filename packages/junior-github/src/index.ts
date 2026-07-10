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
  type Actor,
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
type GitHubGrantName =
  | "installation-issues-write"
  | "installation-pr-branch-write"
  | "installation-pull-requests-write"
  | "installation-read"
  | "user-read"
  | "user-write";
type GitHubGrantReason =
  | "github.api-read"
  | "github.contents-write"
  | "github.fork-create"
  | "github.git-read"
  | "github.git-write"
  | "github.graphql-read"
  | "github.issue-create"
  | "github.issues-write"
  | "github.pull-create"
  | "github.pull-review-write"
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
  loadPermissions?: LoadInstallationReadPermissions;
  permissions?: Record<string, "read" | "write">;
  privateKeyEnv: string;
  repositories?: string[];
}

type LoadInstallationReadPermissions = (input: {
  appJwt: string;
  installationId: number;
}) => Promise<Record<string, "read">>;

interface GitHubRepository {
  name: string;
  owner: string;
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
];
const ISSUES_WRITE_REQUIREMENTS = [
  "GitHub App Issues: write on the target repository",
];
const PULL_REQUESTS_WRITE_REQUIREMENTS = [
  "GitHub App Pull requests: write on the target repository",
];
const PULL_REVIEW_WRITE_REQUIREMENTS = [
  ...PULL_REQUESTS_WRITE_REQUIREMENTS,
  "requesting GitHub user permission to review the pull request",
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

function isUserActor(
  actor: Actor | undefined,
): actor is Extract<Actor, { userId: string }> {
  return Boolean(actor && "userId" in actor);
}

function actorDisplayName(value: unknown, actor?: Actor): string | undefined {
  const name = cleanIdentityPart(value);
  if (
    !name ||
    name.toLowerCase() === "unknown" ||
    name === cleanIdentityPart(isUserActor(actor) ? actor.userId : undefined)
  ) {
    return undefined;
  }
  return isSlackUserId(name) ? undefined : name;
}

function actorName(actor?: Actor): string | undefined {
  if (!isUserActor(actor)) {
    return undefined;
  }
  return (
    actorDisplayName(actor?.fullName, actor) ||
    actorDisplayName(actor?.userName, actor) ||
    undefined
  );
}

function actorEmail(actor?: Actor): string | undefined {
  if (!isUserActor(actor)) {
    return undefined;
  }
  const email = cleanIdentityPart(actor?.email);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

/**
 * Stable identity key for an actor, matching the distinctness rule
 * `instructionActors` uses to build `run.actors` (identity ids only, never
 * display fields) so the run actor is recognized here even under a different
 * display profile.
 */
function actorIdentityKey(actor: Actor): string {
  if (actor.platform === "system") {
    return `system ${actor.name}`;
  }
  return actor.platform === "slack"
    ? `slack ${actor.teamId} ${actor.userId}`
    : `${actor.platform} ${actor.userId}`;
}

/**
 * Build `Co-Authored-By` trailers crediting human run actors.
 *
 * `run.actors` is attribution only (see `multi-actor-runs.md`): a steerer
 * without a resolvable name and email is silently omitted rather than
 * denying the commit. Dedupes by identity and resolved email so the same human
 * under two display profiles, or an actor matching the bot identity, only ever
 * produces one line.
 */
function additionalActorCoauthorTrailers(args: {
  actors?: Actor[];
  botEmail: string;
}): string[] {
  if (!args.actors || args.actors.length === 0) {
    return [];
  }
  const seenEmails = new Set<string>([args.botEmail.toLowerCase()]);
  const seenActors = new Set<string>();
  const trailers: string[] = [];
  for (const candidate of args.actors) {
    const actorKey = actorIdentityKey(candidate);
    if (seenActors.has(actorKey)) {
      continue;
    }
    const name = actorName(candidate);
    const email = actorEmail(candidate);
    if (!name || !email) {
      continue;
    }
    const emailKey = email.toLowerCase();
    if (seenEmails.has(emailKey)) {
      continue;
    }
    seenActors.add(actorKey);
    seenEmails.add(emailKey);
    trailers.push(`Co-Authored-By: ${name} <${email}>`);
  }
  return trailers;
}

function prepareCommitMsgHook(): string {
  return `#!/usr/bin/env bash
set -eu

message_file="\${1:-}"
if [ -z "$message_file" ]; then
  exit 1
fi

if [ -z "\${JUNIOR_GIT_AUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_AUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: Junior author identity was not injected by the host runtime. Do not set Git author env vars manually; report this configuration error." >&2
  exit 1
fi

if [ "\${GIT_AUTHOR_NAME:-}" != "$JUNIOR_GIT_AUTHOR_NAME" ] || [ "\${GIT_AUTHOR_EMAIL:-}" != "$JUNIOR_GIT_AUTHOR_EMAIL" ]; then
  echo "Junior GitHub plugin internal error: Git author was not set to the Junior identity. Do not override Git author manually; report this configuration error." >&2
  exit 1
fi

# Git and GitHub only interpret the final contiguous paragraph as the trailer
# block, so all missing trailers are collected and appended as one block:
# human actor trailers in run order.
desired_trailers=""
add_trailer() {
  desired_trailers="$desired_trailers$1"$'\\n'
}

if [ -n "\${JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS:-}" ]; then
  while IFS= read -r actor_trailer; do
    if [ -n "$actor_trailer" ]; then
      add_trailer "$actor_trailer"
    fi
  done <<< "$JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS"
fi

final_trailer_block=$(awk '
  { lines[NR] = $0 }
  END {
    line = NR
    while (line > 0 && lines[line] == "") {
      line--
    }
    if (line == 0) {
      exit 0
    }
    start = line
    while (start > 0 && lines[start] != "") {
      start--
    }
    for (i = start + 1; i <= line; i++) {
      if (lines[i] !~ /^[[:alnum:]-]+: .+/) {
        exit 0
      }
    }
    for (i = start + 1; i <= line; i++) {
      print lines[i]
    }
  }
' "$message_file")

duplicate_desired_trailer=false
while IFS= read -r desired_trailer; do
  if [ -n "$desired_trailer" ] && [ "$(printf '%s\\n' "$final_trailer_block" | grep -Fxc -- "$desired_trailer")" -gt 1 ]; then
    duplicate_desired_trailer=true
    break
  fi
done <<< "$desired_trailers"

if [ "$duplicate_desired_trailer" = true ]; then
  tmp_file=$(mktemp)
  desired_file=$(mktemp)
  trap 'rm -f "$tmp_file" "$desired_file"' EXIT
  printf '%s' "$desired_trailers" > "$desired_file"
  awk -v desired_file="$desired_file" '
    BEGIN {
      while ((getline value < desired_file) > 0) {
        if (value != "") {
          wanted[value] = 1
        }
      }
      close(desired_file)
    }
    { lines[NR] = $0 }
    END {
      line = NR
      while (line > 0 && lines[line] == "") {
        line--
      }
      start = line
      while (start > 0 && lines[start] != "") {
        start--
      }
      valid = line > 0
      for (i = start + 1; valid && i <= line; i++) {
        if (lines[i] !~ /^[[:alnum:]-]+: .+/) {
          valid = 0
        }
      }
      for (i = 1; i <= NR; i++) {
        if (valid && i > start && i <= line && wanted[lines[i]]) {
          if (seen[lines[i]]++) {
            continue
          }
        }
        print lines[i]
      }
    }
  ' "$message_file" > "$tmp_file"
  cat "$tmp_file" > "$message_file"
fi

missing_trailers=""
collect_missing_trailer() {
  if ! printf '%s\\n' "$final_trailer_block" | grep -Fqx -- "$1"; then
    missing_trailers="\${missing_trailers}\${1}"$'\\n'
  fi
}

while IFS= read -r desired_trailer; do
  if [ -n "$desired_trailer" ]; then
    collect_missing_trailer "$desired_trailer"
  fi
done <<< "$desired_trailers"

if [ -z "$missing_trailers" ]; then
  exit 0
fi

if [ -n "$(tail -c 1 "$message_file")" ]; then
  printf '\\n' >> "$message_file"
fi

if [ -n "$final_trailer_block" ]; then
  printf '%s' "$missing_trailers" >> "$message_file"
else
  printf '\\n%s' "$missing_trailers" >> "$message_file"
fi
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

function decodeGitHubPathSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !decoded.includes("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function githubRepositoryFromUrl(
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

function githubRepositoryLeaseScope(repository: GitHubRepository): string {
  return `repository:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}

function githubRepositoryFromLeaseScope(
  leaseScope: string | undefined,
): GitHubRepository {
  const match = /^repository:([^/]+)\/([^/]+)$/.exec(leaseScope ?? "");
  if (!match?.[1] || !match[2]) {
    throw new GitHubPluginSetupError(
      "GitHub installation write grant is missing a repository lease scope.",
    );
  }
  return { owner: match[1], name: match[2] };
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
  const permissions =
    options.permissions ??
    (await options.loadPermissions?.({ appJwt, installationId }));
  if (!permissions) {
    throw new GitHubPluginSetupError(
      "GitHub installation credential permissions are not configured.",
    );
  }
  const accessTokenResponse = await githubRequest(
    "https://api.github.com",
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: appJwt,
      body: {
        permissions,
        ...(options.repositories ? { repositories: options.repositories } : {}),
      },
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

function createPermissionCache(): LoadInstallationReadPermissions {
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
  // Unknown GraphQL POST bodies are classified as writes and denied by the
  // caller rather than receiving an installation or user credential.
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
  if (
    method === "PATCH" &&
    /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+$/.test(pathname)
  ) {
    return "github.issues-write";
  }
  if (
    (method === "POST" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/(labels|assignees)(?:\/[^/]+)?$/.test(
      pathname,
    )
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
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/ready_for_review$/.test(pathname)
  ) {
    return "github.pull-requests-write";
  }
  if (
    (method === "POST" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/requested_reviewers$/.test(pathname)
  ) {
    return "github.pull-requests-write";
  }
  if (
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews(?:\/[^/]+(?:\/(events|dismissals))?)?$/.test(
      pathname,
    ) &&
    !HTTP_READ_METHODS.has(method)
  ) {
    return "github.pull-review-write";
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
  if (reason === "github.issue-create" || reason === "github.issues-write") {
    return ISSUES_WRITE_REQUIREMENTS;
  }
  if (reason === "github.pull-review-write") {
    return PULL_REVIEW_WRITE_REQUIREMENTS;
  }
  if (
    reason === "github.pull-create" ||
    reason === "github.pull-requests-write"
  ) {
    return PULL_REQUESTS_WRITE_REQUIREMENTS;
  }
  return undefined;
}

function grantForAccess(
  access: PluginGrantAccess,
  reason: GitHubGrantReason,
  name: GitHubGrantName,
  leaseScope?: string,
): GitHubGrant {
  const requirements = grantRequirements(reason);
  return {
    name,
    access,
    ...(leaseScope ? { leaseScope } : {}),
    reason,
    ...(requirements ? { requirements } : {}),
  };
}

function repositoryLeaseScope(upstreamUrl: URL): string {
  const repository = githubRepositoryFromUrl(upstreamUrl);
  if (!repository) {
    throw new EgressPolicyDenied(
      "GitHub write request does not identify a target repository.",
    );
  }
  return githubRepositoryLeaseScope(repository);
}

function installationGrantForWrite(
  reason: GitHubGrantReason,
  upstreamUrl: URL,
): GitHubGrant | undefined {
  const leaseScope = repositoryLeaseScope(upstreamUrl);
  if (reason === "github.issue-create" || reason === "github.issues-write") {
    return grantForAccess(
      "write",
      reason,
      "installation-issues-write",
      leaseScope,
    );
  }
  if (
    reason === "github.pull-create" ||
    reason === "github.pull-requests-write"
  ) {
    return grantForAccess(
      "write",
      reason,
      "installation-pull-requests-write",
      leaseScope,
    );
  }
  if (reason === "github.pull-review-write") {
    return grantForAccess("write", reason, "user-write", leaseScope);
  }
  return undefined;
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
    if (smartHttpAccess === "write") {
      return grantForAccess(
        "write",
        "github.git-write",
        "installation-pr-branch-write",
        repositoryLeaseScope(upstreamUrl),
      );
    }
    return grantForAccess(
      smartHttpAccess,
      "github.git-read",
      "installation-read",
    );
  }

  const userReadReason = githubUserReadReason(method, upstreamUrl);
  if (userReadReason) {
    return grantForAccess("read", userReadReason, "user-read");
  }

  const writeReason = githubApiWriteReason(method, upstreamUrl);
  if (writeReason) {
    const grant = installationGrantForWrite(writeReason, upstreamUrl);
    if (grant) {
      return grant;
    }
    throw new EgressPolicyDenied(
      `GitHub write operation ${writeReason} is not enabled for Junior credentials.`,
    );
  }

  const graphqlAccess = githubGraphqlAccess(
    method,
    upstreamUrl,
    ctx.request.bodyText,
  );
  if (graphqlAccess) {
    if (graphqlAccess === "write") {
      throw new EgressPolicyDenied(
        "GitHub GraphQL mutations are not enabled for Junior credentials.",
      );
    }
    return grantForAccess(
      graphqlAccess,
      "github.graphql-read",
      "installation-read",
    );
  }

  const access = HTTP_READ_METHODS.has(method) ? "read" : "write";
  if (access === "write") {
    throw new EgressPolicyDenied(
      "GitHub write request is not an explicitly allowed Junior operation.",
    );
  }
  return grantForAccess(access, "github.api-read", "installation-read");
}

function configuredWritePermission(
  appPermissions: GitHubAppPermissions | undefined,
  permission: "issues" | "pull_requests",
): Record<string, "read" | "write"> {
  const level = appPermissions?.[permission];
  if (level !== undefined && level !== "write" && level !== "admin") {
    throw new GitHubPluginSetupError(
      `githubPlugin appPermissions.${permission} must allow write access for Junior-owned GitHub resources.`,
    );
  }
  return {
    metadata: "read",
    [permission]: "write",
  };
}

function configuredBranchWritePermissions(
  appPermissions: GitHubAppPermissions | undefined,
): Record<string, "read" | "write"> {
  const contents = appPermissions?.contents;
  if (contents !== undefined && contents !== "write" && contents !== "admin") {
    throw new GitHubPluginSetupError(
      "githubPlugin appPermissions.contents must allow write access for Junior-managed pull request branches.",
    );
  }
  const workflows = appPermissions?.workflows;
  if (
    workflows !== undefined &&
    workflows !== "write" &&
    workflows !== "admin"
  ) {
    throw new GitHubPluginSetupError(
      "githubPlugin appPermissions.workflows must allow write access when configured.",
    );
  }
  return {
    contents: "write",
    metadata: "read",
    ...(workflows === "write" || workflows === "admin"
      ? { workflows: "write" as const }
      : {}),
  };
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
        const botName = readEnv(botNameEnv);
        const botEmail = readEnv(botEmailEnv);
        if (!botName || !botEmail) {
          return;
        }
        ctx.env.set("GIT_AUTHOR_NAME", botName);
        ctx.env.set("GIT_AUTHOR_EMAIL", botEmail);
        ctx.env.set("JUNIOR_GIT_AUTHOR_NAME", botName);
        ctx.env.set("JUNIOR_GIT_AUTHOR_EMAIL", botEmail);
        ctx.env.set("GIT_COMMITTER_NAME", botName);
        ctx.env.set("GIT_COMMITTER_EMAIL", botEmail);
        const actorTrailers = additionalActorCoauthorTrailers({
          actors: [...(ctx.actor ? [ctx.actor] : []), ...(ctx.actors ?? [])],
          botEmail,
        });
        ctx.env.set(
          "JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS",
          actorTrailers.join("\n"),
        );
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
              ...(appReadPermissions
                ? { permissions: appReadPermissions }
                : { loadPermissions: loadReadPermissions }),
            });
          }
          if (
            ctx.grant.name === "installation-issues-write" ||
            ctx.grant.name === "installation-pull-requests-write"
          ) {
            const repository = githubRepositoryFromLeaseScope(
              ctx.grant.leaseScope,
            );
            const permission =
              ctx.grant.name === "installation-issues-write"
                ? "issues"
                : "pull_requests";
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
              permissions: configuredWritePermission(
                appPermissions,
                permission,
              ),
              repositories: [repository.name],
            });
          }
          if (ctx.grant.name === "installation-pr-branch-write") {
            const repository = githubRepositoryFromLeaseScope(
              ctx.grant.leaseScope,
            );
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
              permissions: configuredBranchWritePermissions(appPermissions),
              repositories: [repository.name],
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
