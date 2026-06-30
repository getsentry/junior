// src/index.ts
import { createPrivateKey, createSign } from "crypto";
import {
  defineJuniorPlugin
} from "@sentry/junior-plugin-api";

// src/permissions.ts
var LEVELS = /* @__PURE__ */ new Set(["read", "write", "admin"]);
var WRITE_ONLY_PERMISSIONS = /* @__PURE__ */ new Set(["profile", "workflows"]);
function isLevel(value) {
  return LEVELS.has(value);
}
function normalizeScope(rawScope) {
  return String(rawScope).trim().replace(/-/g, "_");
}
function normalizePermissions(permissions) {
  if (permissions === void 0) {
    return void 0;
  }
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    throw new Error(
      "githubPlugin appPermissions must contain at least one permission when provided."
    );
  }
  const request = {};
  for (const [rawScope, rawLevel] of entries) {
    const normalizedScope = normalizeScope(rawScope);
    if (!normalizedScope) {
      throw new Error(
        "githubPlugin appPermissions contains an empty permission name."
      );
    }
    if (!/^[a-z][a-z0-9_]*$/.test(normalizedScope)) {
      throw new Error(
        `githubPlugin appPermissions contains invalid permission "${rawScope}".`
      );
    }
    if (!isLevel(rawLevel)) {
      throw new Error(
        `githubPlugin appPermissions.${rawScope} must be "read", "write", or "admin".`
      );
    }
    request[normalizedScope] = rawLevel;
  }
  return request;
}
function readGrantPermissions(permissions) {
  const readOnly = { metadata: "read" };
  for (const [scope, level] of Object.entries(permissions ?? {})) {
    if (!isLevel(level)) {
      throw new Error(
        `GitHub permission "${scope}" returned invalid level "${String(level)}".`
      );
    }
    if (!WRITE_ONLY_PERMISSIONS.has(scope)) {
      readOnly[scope] = "read";
    }
  }
  return readOnly;
}
function permissionCapabilities(permissions) {
  if (permissions === void 0) {
    return void 0;
  }
  return Object.entries(permissions).map(([normalizedScope, rawLevel]) => {
    const scope = normalizedScope.replace(/_/g, "-");
    return `github.${scope}.${rawLevel}`;
  }).sort();
}

// src/tools/create-issue.ts
import {
  PluginToolInputError
} from "@sentry/junior-plugin-api";
var GITHUB_ISSUE_FOOTER_START = "<!-- junior-session-footer:start -->";
var GITHUB_ISSUE_FOOTER_END = "<!-- junior-session-footer:end -->";
var GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var GITHUB_ISSUE_CREATE_LOCK_TTL_MS = 6e4;
var GitHubIssueCreateRejectedError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "GitHubIssueCreateRejectedError";
    this.status = status;
  }
};
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginToolInputError(`${name} is required`);
  }
  return value.trim();
}
function optionalString(value, name) {
  if (value === void 0 || value === null) {
    return void 0;
  }
  if (typeof value !== "string") {
    throw new PluginToolInputError(`${name} must be a string`);
  }
  return value;
}
function optionalStringList(value, name) {
  if (value === void 0 || value === null) {
    return void 0;
  }
  if (!Array.isArray(value)) {
    throw new PluginToolInputError(`${name} must be an array`);
  }
  const entries = value.map((entry) => requiredString(entry, `${name} entry`));
  return entries.length ? entries : void 0;
}
function parseRepo(value) {
  const repo = requiredString(value, "repo");
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return {
    owner: parts[0].trim(),
    name: parts[1].trim()
  };
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function githubIssueConversationFooter(conversationId) {
  const id = requiredString(conversationId, "conversationId");
  return `${GITHUB_ISSUE_FOOTER_START}

---
Created by Junior.
Conversation: \`${id}\`

${GITHUB_ISSUE_FOOTER_END}`;
}
function appendGitHubIssueFooter(body, conversationId) {
  const footer = githubIssueConversationFooter(conversationId);
  const normalizedBody = body.trimEnd();
  const existingFooter = new RegExp(
    `${escapeRegExp(GITHUB_ISSUE_FOOTER_START)}[\\s\\S]*?${escapeRegExp(
      GITHUB_ISSUE_FOOTER_END
    )}`
  );
  if (existingFooter.test(normalizedBody)) {
    return normalizedBody.replace(existingFooter, footer);
  }
  return normalizedBody ? `${normalizedBody}

${footer}` : footer;
}
async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return void 0;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function githubApiErrorMessage(payload) {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return "GitHub request failed";
}
function createIssueResult(value) {
  if (isRecord(value) && value.status === "completed" && typeof value.number === "number" && typeof value.url === "string") {
    return {
      number: value.number,
      url: value.url
    };
  }
  return void 0;
}
function isPendingCreateIssue(value) {
  return isRecord(value) && value.status === "pending";
}
function createGitHubIssueRequest(ctx, input) {
  const repo = parseRepo(input.repo);
  const title = requiredString(input.title, "title");
  const body = optionalString(input.body, "body") ?? "";
  const labels = optionalStringList(input.labels, "labels");
  const payload = {
    title,
    body: appendGitHubIssueFooter(body, ctx.conversationId),
    ...labels ? { labels } : {}
  };
  return new Request(
    `https://api.github.com/repos/${encodeURIComponent(
      repo.owner
    )}/${encodeURIComponent(repo.name)}/issues`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(payload)
    }
  );
}
async function createGitHubIssue(ctx, request) {
  const response = await ctx.egress.fetch({
    provider: "github",
    operation: "github.issue.create",
    request
  });
  const parsed = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubIssueCreateRejectedError(
      `GitHub issue creation failed with HTTP ${response.status}: ${githubApiErrorMessage(
        parsed
      )}`,
      response.status
    );
  }
  if (!isRecord(parsed) || typeof parsed.number !== "number" || typeof parsed.html_url !== "string") {
    throw new Error("GitHub issue creation returned an invalid response.");
  }
  return {
    number: parsed.number,
    url: parsed.html_url
  };
}
function createGitHubIssueTool(ctx) {
  return {
    description: "Create a GitHub issue with a runtime-owned Junior conversation footer. Use this instead of shelling out to gh issue create when creating issues.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "title"],
      properties: {
        repo: {
          type: "string",
          description: 'Repository in "owner/name" format.'
        },
        title: {
          type: "string",
          description: "Issue title."
        },
        body: {
          type: "string",
          description: "Issue body. Junior appends the conversation footer."
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply to the issue."
        }
      }
    },
    async execute(input, options) {
      const conversationId = requiredString(
        ctx.conversationId,
        "conversationId"
      );
      const toolCallId = requiredString(options?.toolCallId, "toolCallId");
      const key = `createIssue:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(
        `${key}:lock`,
        GITHUB_ISSUE_CREATE_LOCK_TTL_MS,
        async () => {
          const existing = createIssueResult(await ctx.state.get(key));
          if (existing) {
            return existing;
          }
          if (isPendingCreateIssue(await ctx.state.get(key))) {
            throw new Error(
              "GitHub issue creation for this tool call has an uncertain pending result; refusing to create a duplicate issue."
            );
          }
          const request = createGitHubIssueRequest(ctx, input);
          await ctx.state.set(
            key,
            { status: "pending", createdAtMs: Date.now() },
            GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS
          );
          try {
            const result = await createGitHubIssue(ctx, request);
            try {
              await ctx.state.set(
                key,
                { status: "completed", ...result },
                GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS
              );
            } catch {
              return result;
            }
            return result;
          } catch (error) {
            if (error instanceof GitHubIssueCreateRejectedError && error.status >= 400 && error.status < 500) {
              await ctx.state.delete(key);
            }
            throw error;
          }
        }
      );
    }
  };
}

// src/tools.ts
function createGitHubTools(ctx) {
  return {
    createIssue: createGitHubIssueTool(ctx)
  };
}

// src/index.ts
var GITHUB_APP_ID_ENV = "GITHUB_APP_ID";
var GITHUB_APP_PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY";
var GITHUB_INSTALLATION_ID_ENV = "GITHUB_INSTALLATION_ID";
var GITHUB_AUTH_TOKEN_ENV = "GITHUB_TOKEN";
var GITHUB_AUTH_TOKEN_PLACEHOLDER = "ghp_host_managed_credential";
var MAX_LEASE_MS = 60 * 60 * 1e3;
var REFRESH_BUFFER_MS = 5 * 60 * 1e3;
var USER_REFRESH_TIMEOUT_MS = 2e4;
var GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
var HTTP_READ_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
var USER_TOKEN_GRANTS = /* @__PURE__ */ new Set(["user-read", "user-write"]);
var CONTENTS_WRITE_REQUIREMENTS = [
  "GitHub App Contents: write on the target repository",
  "requesting GitHub user write access to the repository"
];
var WORKFLOWS_WRITE_REQUIREMENTS = [
  "GitHub App Contents: write and Workflows: write on the target repository",
  "requesting GitHub user write access to the repository"
];
var ISSUES_WRITE_REQUIREMENTS = [
  "GitHub App Issues: write on the target repository",
  "requesting GitHub user issue access to the repository"
];
var PULL_REQUESTS_WRITE_REQUIREMENTS = [
  "GitHub App Pull requests: write on the target repository",
  "requesting GitHub user write access to the repository"
];
var FORK_CREATE_REQUIREMENTS = [
  "GitHub App Administration: write and Contents: read",
  "app installation access on the source and destination accounts",
  "requesting GitHub user permission to fork the repository"
];
var GitHubUserRefreshRejectedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubUserRefreshRejectedError";
  }
};
var GitHubRequestError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
};
var GitHubPluginSetupError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubPluginSetupError";
  }
};
function isRecord2(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : void 0;
}
function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new GitHubPluginSetupError(`Missing ${name}`);
  }
  return value;
}
function normalizeScopeList(scopes) {
  return [
    ...new Set(
      (scopes ?? []).flatMap((scope) => String(scope).split(/\s+/)).map((scope) => scope.trim()).filter(Boolean)
    )
  ].sort();
}
function normalizeOAuthScope(scope) {
  const normalized = normalizeScopeList(scope ? [scope] : []);
  return normalized.length ? normalized.join(" ") : void 0;
}
function hasRequiredOAuthScope(storedScope, requiredScope) {
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
function cleanIdentityPart(value) {
  return String(value ?? "").replaceAll("\n", " ").replaceAll("\r", " ").replace(/[<>]/g, "").trim();
}
function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{5,}$/.test(value);
}
function requesterDisplayName(value, requester) {
  const name = cleanIdentityPart(value);
  if (!name || name.toLowerCase() === "unknown" || name === cleanIdentityPart(requester?.userId)) {
    return void 0;
  }
  return isSlackUserId(name) ? void 0 : name;
}
function requesterName(requester) {
  return requesterDisplayName(requester?.fullName, requester) || requesterDisplayName(requester?.userName, requester) || void 0;
}
function requesterEmail(requester) {
  const email = cleanIdentityPart(requester?.email);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : void 0;
}
function isGitCommitCommand(command) {
  return /(?:^|[\s;|&])git(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)))*\s+commit(?:\s|$)/.test(
    command
  );
}
function prepareCommitMsgHook() {
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
async function configureGit(ctx, key, value) {
  const result = await ctx.sandbox.run({
    cmd: "git",
    args: ["config", "--global", key, value]
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to configure git ${key}: ${result.stderr || result.stdout}`
    );
  }
}
function base64Url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function getPrivateKey(envName) {
  const raw = requireEnv(envName);
  let key;
  try {
    key = createPrivateKey({ key: raw, format: "pem" });
  } catch {
    throw new GitHubPluginSetupError(
      `Invalid ${envName}: expected a PEM-encoded RSA private key`
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new GitHubPluginSetupError(
      `Invalid ${envName}: GitHub App signing requires an RSA private key`
    );
  }
  return key;
}
function createAppJwt(appId, privateKeyEnv) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(getPrivateKey(privateKeyEnv)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${signature}`;
}
async function githubRequest(apiBase, path, params) {
  const response = await fetch(`${apiBase}${path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...params.body ? { "Content-Type": "application/json" } : {}
    },
    ...params.body ? { body: JSON.stringify(params.body) } : {}
  });
  const text = await response.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = void 0;
    }
  }
  if (!response.ok) {
    const message = isRecord2(parsed) && typeof parsed.message === "string" ? parsed.message : `GitHub API error ${response.status}`;
    throw new GitHubRequestError(message, response.status);
  }
  return parsed;
}
function buildOAuthTokenRequest(input) {
  const payload = {
    ...input.payload,
    client_id: input.clientId,
    client_secret: input.clientSecret
  };
  return {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(payload)
  };
}
function parseOAuthResponseJson(responseText) {
  if (!responseText.trim()) {
    return void 0;
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return void 0;
  }
}
function oauthErrorCode(data) {
  return isRecord2(data) && typeof data.error === "string" ? data.error : void 0;
}
function isRejectedRefreshError(errorCode) {
  return errorCode === "bad_refresh_token" || errorCode === "invalid_grant";
}
function parseOAuthTokenResponse(data, requestedScope) {
  if (!isRecord2(data)) {
    throw new Error("OAuth token response is invalid");
  }
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("OAuth token response missing access_token");
  }
  if (typeof data.refresh_token !== "string" || !data.refresh_token.trim()) {
    throw new Error("OAuth token response missing refresh_token");
  }
  let scope = normalizeOAuthScope(requestedScope);
  if (data.scope !== void 0) {
    if (typeof data.scope !== "string") {
      throw new Error("OAuth token response returned invalid scope");
    }
    scope = normalizeOAuthScope(data.scope) ?? scope;
  }
  const result = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    ...scope ? { scope } : {}
  };
  if (data.expires_in !== void 0) {
    if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error("OAuth token response returned invalid expires_in");
    }
    result.expiresAt = Date.now() + data.expires_in * 1e3;
  }
  if (data.refresh_token_expires_in !== void 0) {
    if (typeof data.refresh_token_expires_in !== "number" || !Number.isFinite(data.refresh_token_expires_in) || data.refresh_token_expires_in <= 0) {
      throw new Error(
        "OAuth token response returned invalid refresh_token_expires_in"
      );
    }
    result.refreshTokenExpiresAt = Date.now() + data.refresh_token_expires_in * 1e3;
  }
  return result;
}
async function refreshUserAccessToken(input) {
  const clientId = requireEnv(input.clientIdEnv);
  const clientSecret = requireEnv(input.clientSecretEnv);
  const request = buildOAuthTokenRequest({
    clientId,
    clientSecret,
    payload: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken
    }
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(USER_REFRESH_TIMEOUT_MS)
  });
  const responseText = await response.text();
  const responseData = parseOAuthResponseJson(responseText);
  const errorCode = oauthErrorCode(responseData);
  if (isRejectedRefreshError(errorCode)) {
    throw new GitHubUserRefreshRejectedError(
      `GitHub user token refresh rejected: ${errorCode}`
    );
  }
  if (!response.ok || errorCode) {
    throw new Error(
      `GitHub user token refresh failed: ${response.status}${errorCode ? ` ${errorCode}` : ""}`
    );
  }
  try {
    return parseOAuthTokenResponse(responseData, input.requestedScope);
  } catch (error) {
    if (error instanceof Error && error.message === "OAuth token response missing access_token") {
      throw new GitHubUserRefreshRejectedError(error.message);
    }
    throw error;
  }
}
function leaseExpiry(expiresAt) {
  return expiresAt ? Math.min(expiresAt, Date.now() + MAX_LEASE_MS) : Date.now() + MAX_LEASE_MS;
}
function isGitSmartHttpDomain(domain) {
  return domain.toLowerCase() === "github.com";
}
function authorizationFor(domain, token) {
  if (isGitSmartHttpDomain(domain)) {
    return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return `Bearer ${token}`;
}
function createCredentialLease(input) {
  return {
    type: "lease",
    lease: {
      ...input.account ? { account: input.account } : {},
      ...input.authorization ? { authorization: input.authorization } : {},
      expiresAt: new Date(input.expiresAtMs).toISOString(),
      headerTransforms: ["api.github.com", "github.com"].map((domain) => ({
        domain,
        headers: {
          Authorization: authorizationFor(domain, input.token)
        }
      }))
    }
  };
}
function githubUserAuthorization(scope) {
  return {
    type: "oauth",
    provider: "github",
    ...scope ? { scope } : {}
  };
}
function credentialNeeded(message, scope, allowAuthorization = true) {
  return {
    type: "needed",
    message,
    ...allowAuthorization ? { authorization: githubUserAuthorization(scope) } : {}
  };
}
function credentialUnavailable(message) {
  return {
    type: "unavailable",
    message
  };
}
function parseInstallationTokenResponse(data) {
  if (!isRecord2(data)) {
    throw new Error("GitHub installation token response is invalid");
  }
  const token = data.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("GitHub installation token response missing token");
  }
  const expiresAt = data.expires_at;
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error(
      "GitHub installation token response returned invalid expires_at"
    );
  }
  return { token, expiresAtMs };
}
function readInstallationPermissions(installation) {
  if (!isRecord2(installation) || !isRecord2(installation.permissions)) {
    throw new Error("GitHub installation response missing permissions");
  }
  return readGrantPermissions(installation.permissions);
}
async function resolveUserAccount(tokens) {
  const account = await githubRequest("https://api.github.com", "/user", {
    token: tokens.accessToken
  });
  if (!isRecord2(account)) {
    throw new Error("GitHub user response is invalid");
  }
  const id = account.id;
  const login = account.login;
  if (typeof id !== "number" && typeof id !== "string" || typeof login !== "string" || !login.trim()) {
    throw new Error("GitHub user response missing id or login");
  }
  const url = typeof account.html_url === "string" ? account.html_url : void 0;
  return {
    id: String(id),
    label: login.trim(),
    ...url ? { url } : {}
  };
}
async function tokensWithAccount(tokenSlot, stored, scope) {
  if (stored.account) {
    return { ok: true, tokens: stored };
  }
  let account;
  try {
    account = await resolveUserAccount(stored);
  } catch (error) {
    if (error instanceof GitHubRequestError && (error.status === 401 || error.status === 403)) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope
        )
      };
    }
    throw error;
  }
  const updated = { ...stored, account };
  await tokenSlot.set(updated);
  return { ok: true, tokens: updated };
}
function shouldRefreshUserToken(stored, now = Date.now()) {
  return stored.expiresAt !== void 0 && stored.expiresAt - now < REFRESH_BUFFER_MS;
}
function canUseStoredUserToken(stored) {
  return stored.expiresAt === void 0 || stored.expiresAt > Date.now() && !shouldRefreshUserToken(stored);
}
async function refreshUserTokensWithLock(tokenSlot, scope, options) {
  return await tokenSlot.withRefresh(async () => {
    const latest = await tokenSlot.get();
    if (!latest) {
      return {
        ok: false,
        result: credentialNeeded("Connect your GitHub account.", scope)
      };
    }
    if (!hasRequiredOAuthScope(latest.scope, scope)) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope
        )
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
        requestedScope: latest.scope ?? scope
      });
    } catch (error) {
      if (!(error instanceof GitHubUserRefreshRejectedError)) {
        throw error;
      }
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization has expired.",
          scope
        )
      };
    }
    if (!hasRequiredOAuthScope(refreshed.scope, scope)) {
      return {
        ok: false,
        result: credentialNeeded(
          "Your GitHub authorization needs to be refreshed.",
          scope
        )
      };
    }
    const refreshedTokens = {
      ...latest.refreshTokenExpiresAt ? { refreshTokenExpiresAt: latest.refreshTokenExpiresAt } : {},
      ...refreshed,
      ...latest.account ? { account: latest.account } : {}
    };
    await tokenSlot.set(refreshedTokens);
    return { ok: true, tokens: refreshedTokens };
  });
}
async function issueUserCredential(ctx, options) {
  const scope = options.userScope;
  const tokenSlot = ctx.tokens.currentUser ?? ctx.tokens.credentialSubject;
  if (!tokenSlot) {
    return credentialNeeded(
      "GitHub write access requires a current user or delegated user credential subject.",
      scope,
      false
    );
  }
  const stored = await tokenSlot.get();
  if (!stored) {
    return credentialNeeded(
      "GitHub write access requires user authorization.",
      scope
    );
  }
  if (!hasRequiredOAuthScope(stored.scope, scope)) {
    return credentialNeeded(
      "Your GitHub authorization needs to be refreshed.",
      scope
    );
  }
  const now = Date.now();
  if (stored.expiresAt !== void 0 && stored.expiresAt - now < REFRESH_BUFFER_MS) {
    const refreshResult = await refreshUserTokensWithLock(
      tokenSlot,
      scope,
      options
    );
    if (!refreshResult.ok) {
      return refreshResult.result;
    }
    const withAccount = await tokensWithAccount(
      tokenSlot,
      refreshResult.tokens,
      scope
    );
    if (!withAccount.ok) {
      return withAccount.result;
    }
    return createCredentialLease({
      account: withAccount.tokens.account,
      token: withAccount.tokens.accessToken,
      expiresAtMs: leaseExpiry(withAccount.tokens.expiresAt),
      authorization: githubUserAuthorization(scope)
    });
  }
  if (stored.expiresAt === void 0 || stored.expiresAt > Date.now()) {
    const withAccount = await tokensWithAccount(tokenSlot, stored, scope);
    if (!withAccount.ok) {
      return withAccount.result;
    }
    return createCredentialLease({
      account: withAccount.tokens.account,
      token: withAccount.tokens.accessToken,
      expiresAtMs: leaseExpiry(withAccount.tokens.expiresAt),
      authorization: githubUserAuthorization(scope)
    });
  }
  return credentialNeeded("Your GitHub authorization has expired.", scope);
}
async function issueInstallationCredential(options) {
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
      installationId
    });
  }
  const accessTokenResponse = await githubRequest(
    "https://api.github.com",
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: appJwt,
      body: { permissions: tokenPermissions }
    }
  );
  const parsedToken = parseInstallationTokenResponse(accessTokenResponse);
  const expiresAtMs = Math.min(
    parsedToken.expiresAtMs,
    Date.now() + MAX_LEASE_MS
  );
  return createCredentialLease({
    token: parsedToken.token,
    expiresAtMs
  });
}
function createPermissionCache() {
  let cached;
  let pending;
  return async ({ appJwt, installationId }) => {
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.permissions;
    }
    pending ??= githubRequest(
      "https://api.github.com",
      `/app/installations/${installationId}`,
      { token: appJwt }
    ).then((installation) => {
      const permissions = readInstallationPermissions(installation);
      cached = {
        expiresAtMs: Date.now() + MAX_LEASE_MS,
        permissions
      };
      return permissions;
    }).finally(() => {
      pending = void 0;
    });
    return await pending;
  };
}
function githubSmartHttpAccess(upstreamUrl) {
  const pathname = upstreamUrl.pathname.toLowerCase();
  const service = upstreamUrl.searchParams.get("service")?.toLowerCase();
  const isSmartHttpPath = pathname.endsWith("/info/refs") || pathname.endsWith("/git-receive-pack") || pathname.endsWith("/git-upload-pack");
  if (!isSmartHttpPath) {
    return void 0;
  }
  if (pathname.endsWith("/git-receive-pack") || service === "git-receive-pack") {
    return "write";
  }
  if (pathname.endsWith("/git-upload-pack") || service === "git-upload-pack") {
    return "read";
  }
  return void 0;
}
function isGitHubGraphqlUrl(upstreamUrl) {
  return upstreamUrl.hostname.toLowerCase() === "api.github.com" && upstreamUrl.pathname.toLowerCase().endsWith("/graphql");
}
function isGitHubApiUrl(upstreamUrl) {
  return upstreamUrl.hostname.toLowerCase() === "api.github.com";
}
function githubUserReadReason(method, upstreamUrl) {
  if (method !== "GET" || !isGitHubApiUrl(upstreamUrl)) {
    return void 0;
  }
  return upstreamUrl.pathname.toLowerCase() === "/user" ? "github.user-read" : void 0;
}
function parseGitHubGraphqlOperation(bodyText) {
  if (typeof bodyText !== "string" || bodyText.trim().length === 0) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return void 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return void 0;
  }
  const query = parsed.query;
  if (typeof query !== "string") {
    return void 0;
  }
  const operationName = typeof parsed.operationName === "string" ? parsed.operationName.trim() : void 0;
  const normalized = maskGraphqlStringLiterals(
    query.replace(/^\s*#[^\n\r]*(?:\r?\n|$)/gm, "")
  ).trim();
  if (operationName) {
    const namedOperation = normalized.match(
      new RegExp(
        `\\b(query|mutation|subscription)\\s+${escapeRegExp2(operationName)}\\b`
      )
    )?.[1];
    return namedOperation ? graphqlOperationAccess(namedOperation) : void 0;
  }
  const operation = normalized.match(/\b(query|mutation|subscription)\b/)?.[1];
  const operationAccess = graphqlOperationAccess(operation);
  if (operationAccess) {
    return operationAccess;
  }
  if (normalized.startsWith("{")) {
    return "read";
  }
  return void 0;
}
function escapeRegExp2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function graphqlOperationAccess(operation) {
  if (operation === "mutation" || operation === "subscription") {
    return "write";
  }
  if (operation === "query") {
    return "read";
  }
  return void 0;
}
function maskGraphqlStringLiterals(query) {
  return query.replace(
    /"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g,
    (match) => " ".repeat(match.length)
  );
}
function githubGraphqlAccess(method, upstreamUrl, bodyText) {
  if (!isGitHubGraphqlUrl(upstreamUrl)) {
    return void 0;
  }
  if (HTTP_READ_METHODS.has(method)) {
    return "read";
  }
  const operation = parseGitHubGraphqlOperation(bodyText);
  if (operation) {
    return operation;
  }
  return "write";
}
function githubGraphqlPermissionDeniedMessage(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return void 0;
  }
  if (!isRecord2(parsed) || !Array.isArray(parsed.errors)) {
    return void 0;
  }
  for (const error of parsed.errors) {
    if (!isRecord2(error) || typeof error.message !== "string") {
      continue;
    }
    const message = error.message;
    if (error.type === "NOT_FOUND" && /\bCould not resolve to a Repository with the name\b/.test(message)) {
      return `GitHub GraphQL could not access the repository: ${message}`;
    }
    if (/\bResource not accessible by integration\b/.test(message)) {
      return `GitHub GraphQL denied access: ${message}`;
    }
  }
  return void 0;
}
function shouldInspectGitHubGraphqlResponse(ctx) {
  if (ctx.request.method.toUpperCase() !== "POST" || ctx.response.status !== 200) {
    return false;
  }
  let upstreamUrl;
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
function githubApiWriteReason(method, upstreamUrl) {
  const pathname = upstreamUrl.pathname.toLowerCase();
  if (!isGitHubApiUrl(upstreamUrl)) {
    return void 0;
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(pathname)) {
    return "github.issue-create";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/.test(pathname)) {
    return "github.issues-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(pathname)) {
    return "github.pull-create";
  }
  if (method === "PATCH" && /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/.test(pathname)) {
    return "github.pull-requests-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/forks$/.test(pathname)) {
    return "github.fork-create";
  }
  if (/^\/repos\/[^/]+\/[^/]+\/contents(?:\/|$)/.test(pathname) && (method === "PUT" || method === "DELETE")) {
    return pathname.includes("/.github/workflows/") ? "github.workflows-write" : "github.contents-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits)$/.test(pathname)) {
    return "github.contents-write";
  }
  if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(pathname)) {
    return "github.contents-write";
  }
  if ((method === "PATCH" || method === "DELETE") && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/.+/.test(pathname)) {
    return "github.contents-write";
  }
  if (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/.test(pathname)) {
    return "github.contents-write";
  }
  return void 0;
}
function grantRequirements(reason) {
  if (reason === "github.git-write" || reason === "github.contents-write") {
    return CONTENTS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.workflows-write") {
    return WORKFLOWS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.issue-create" || reason === "github.issues-write") {
    return ISSUES_WRITE_REQUIREMENTS;
  }
  if (reason === "github.pull-create" || reason === "github.pull-requests-write") {
    return PULL_REQUESTS_WRITE_REQUIREMENTS;
  }
  if (reason === "github.fork-create") {
    return FORK_CREATE_REQUIREMENTS;
  }
  return void 0;
}
function grantForAccess(access, reason, name) {
  const requirements = grantRequirements(reason);
  return {
    name,
    access,
    reason,
    ...requirements ? { requirements } : {}
  };
}
async function githubGrantForEgress(ctx) {
  const method = ctx.request.method.toUpperCase();
  const upstreamUrl = new URL(ctx.request.url);
  const smartHttpAccess = githubSmartHttpAccess(upstreamUrl);
  if (smartHttpAccess) {
    return grantForAccess(
      smartHttpAccess,
      smartHttpAccess === "write" ? "github.git-write" : "github.git-read",
      smartHttpAccess === "write" ? "user-write" : "installation-read"
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
    ctx.request.bodyText
  );
  if (graphqlAccess) {
    return grantForAccess(
      graphqlAccess,
      graphqlAccess === "write" ? "github.graphql-write" : "github.graphql-read",
      graphqlAccess === "write" ? "user-write" : "installation-read"
    );
  }
  const access = HTTP_READ_METHODS.has(method) ? "read" : "write";
  return grantForAccess(
    access,
    access === "write" ? "github.api-write" : "github.api-read",
    access === "write" ? "user-write" : "installation-read"
  );
}
function githubPlugin(options = {}) {
  const botNameEnv = options.botNameEnv ?? "GITHUB_APP_BOT_NAME";
  const botEmailEnv = options.botEmailEnv ?? "GITHUB_APP_BOT_EMAIL";
  const clientIdEnv = options.clientIdEnv ?? "GITHUB_APP_CLIENT_ID";
  const clientSecretEnv = options.clientSecretEnv ?? "GITHUB_APP_CLIENT_SECRET";
  const appIdEnv = options.appIdEnv ?? GITHUB_APP_ID_ENV;
  const privateKeyEnv = options.privateKeyEnv ?? GITHUB_APP_PRIVATE_KEY_ENV;
  const installationIdEnv = options.installationIdEnv ?? GITHUB_INSTALLATION_ID_ENV;
  const appPermissions = normalizePermissions(options.appPermissions);
  const appReadPermissions = appPermissions ? readGrantPermissions(appPermissions) : void 0;
  const loadReadPermissions = createPermissionCache();
  const appCapabilities = permissionCapabilities(appPermissions);
  const userScopes = normalizeScopeList(options.additionalUserScopes);
  const userScope = userScopes.length ? userScopes.join(" ") : void 0;
  return defineJuniorPlugin({
    packageName: "@sentry/junior-github",
    manifest: {
      name: "github",
      displayName: "GitHub",
      description: "GitHub issue, pull request, and repository workflows via GitHub App",
      ...appCapabilities ? { capabilities: appCapabilities } : {},
      configKeys: ["org", "repo"],
      domains: ["api.github.com", "github.com"],
      envVars: {
        [appIdEnv]: {},
        [privateKeyEnv]: {},
        [installationIdEnv]: {},
        [clientIdEnv]: {},
        [clientSecretEnv]: {},
        [botNameEnv]: { exposeToCommandEnv: true },
        [botEmailEnv]: { exposeToCommandEnv: true }
      },
      oauth: {
        clientIdEnv,
        clientSecretEnv,
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        // GitHub App user-to-server tokens always return scope: "" regardless
        // of what was requested; treat empty response scope as unreported.
        treatEmptyScopeAsUnreported: true,
        ...userScope ? { scope: userScope } : {}
      },
      commandEnv: {
        [GITHUB_AUTH_TOKEN_ENV]: GITHUB_AUTH_TOKEN_PLACEHOLDER,
        GIT_COMMITTER_NAME: `\${${botNameEnv}}`,
        GIT_COMMITTER_EMAIL: `\${${botEmailEnv}}`
      },
      target: {
        type: "repo",
        configKey: "repo",
        commandFlags: ["--repo", "-R"]
      },
      runtimeDependencies: [
        {
          type: "system",
          package: "gh"
        }
      ]
    },
    hooks: {
      tools(ctx) {
        return createGitHubTools(ctx);
      },
      async sandboxPrepare(ctx) {
        const hooksPath = `${ctx.sandbox.juniorRoot}/git-hooks`;
        await ctx.sandbox.writeFile({
          path: `${hooksPath}/prepare-commit-msg`,
          mode: 493,
          content: prepareCommitMsgHook()
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
        const command = typeof ctx.tool.input === "object" && ctx.tool.input && "command" in ctx.tool.input ? String(ctx.tool.input.command ?? "") : "";
        const botName = readEnv(botNameEnv);
        const botEmail = readEnv(botEmailEnv);
        if ((!botName || !botEmail) && isGitCommitCommand(command)) {
          ctx.decision.deny(
            `Junior GitHub plugin is misconfigured: host env vars ${botNameEnv} and ${botEmailEnv} are missing. This is an internal deployment configuration error; do not set them in the sandbox.`
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
            "Junior GitHub plugin could not determine a resolved requester name and email for commit attribution. This is an internal request-context error; do not set author env vars manually."
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
          GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES
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
              loadReadPermissions
            });
          }
          if (USER_TOKEN_GRANTS.has(ctx.grant.name)) {
            return await issueUserCredential(ctx, {
              clientIdEnv,
              clientSecretEnv,
              userScope
            });
          }
        } catch (error) {
          if (error instanceof GitHubPluginSetupError) {
            return credentialUnavailable(error.message);
          }
          throw error;
        }
        throw new Error(
          `GitHub plugin cannot issue unknown grant "${ctx.grant.name}".`
        );
      }
    }
  });
}
export {
  githubPlugin
};
//# sourceMappingURL=index.js.map