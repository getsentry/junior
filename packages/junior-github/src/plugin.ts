/**
 * GitHub plugin runtime boundary.
 *
 * This module composes GitHub hooks and owns GitHub egress policy.
 */
import {
  defineJuniorPlugin,
  EgressPolicyDenied,
  enforceEgressPolicy,
  type EgressHookContext,
  type EgressResponseHookContext,
  type PluginGrantAccess,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  type GitHubAppPermissions,
  normalizePermissions,
  readGrantPermissions,
} from "./permissions.js";
import { assertGitHubPullRequestApprovalDenied } from "./pull-request-review-policy.js";
import { createGitHubTools } from "./tools.js";
import { createGitHubWebhookRoute } from "./webhooks/handler.js";
import {
  GITHUB_DEPLOYMENT_EVENTS,
  GITHUB_DEPLOYMENT_SUGGESTED_EVENTS,
} from "./resource-events/deployment.js";
import {
  GITHUB_ISSUE_EVENTS,
  GITHUB_ISSUE_SUGGESTED_EVENTS,
} from "./resource-events/issue.js";
import {
  GITHUB_PULL_REQUEST_EVENTS,
  GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
} from "./resource-events/pull-request.js";
import {
  GITHUB_RELEASE_EVENTS,
  GITHUB_RELEASE_SUGGESTED_EVENTS,
} from "./resource-events/release.js";
import type { GitHubDb } from "./db/database.js";
import { buildGitHubProfileReport } from "./outcomes/profile-report.js";
import { buildGitHubOutcomeReport } from "./outcomes/report.js";
import { classifyGitHubPullRequestCommitComposition } from "./pull-request-outcomes/commit-composition.js";
import { githubSidebarAnnotations } from "./annotations.js";
import {
  listGitHubAssignedWork,
  listGitHubFinishedWork,
  listGitHubUnfinishedWork,
} from "./pull-request-outcomes/store.js";
import { loadFailingChecksForSuite } from "./webhooks/check-suite-enrichment.js";
import {
  additionalActorCoauthorTrailers,
  configureGit,
  prepareCommitMsgHook,
} from "./git-config.js";
import { linkifyGitHubReferences } from "./reply-markdown.js";
import { isReservedSandboxDirectory } from "./sandbox-paths.js";
import {
  CREATE_TOOL_ROUTING_GUIDANCE,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_ENV,
  GITHUB_AUTH_TOKEN_ENV,
  GITHUB_AUTH_TOKEN_PLACEHOLDER,
  GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
  GITHUB_INSTALLATION_ID_ENV,
  HTTP_READ_METHODS,
  USER_TOKEN_GRANTS,
  USER_WRITE_REQUIREMENTS,
  GitHubPluginSetupError,
  createPermissionCache,
  credentialUnavailable,
  githubRepositoryFromLeaseScope,
  githubRepositoryFromUrl,
  githubRepositoryLeaseScope,
  githubRequest,
  isRecord,
  issueInstallationCredential,
  issueInstallationToken,
  issueUserCredential,
  normalizeScopeList,
  readEnv,
  requireEnv,
  resolveUserAccount,
  type GitHubGrant,
  type GitHubGrantName,
  type GitHubGrantReason,
} from "./credential-support.js";

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
   * GitHub App permissions Junior should downscope to read for
   * installation-read tokens.
   *
   * Keys may use GitHub permission names with underscores or hyphens.
   * Installation-write tokens inherit the App installation's complete
   * permission envelope. GitHub remains the source of truth for whether a
   * permission exists.
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

function isGitHubAssetUploadRequest(method: string, upstreamUrl: URL): boolean {
  return (
    method === "POST" &&
    upstreamUrl.hostname.toLowerCase() === "uploads.github.com" &&
    upstreamUrl.pathname === "/user-attachments/assets"
  );
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

/** GitHub body writes that must go through a typed tool. */
type GitHubBodyWrite = {
  denialMessage: string;
  graphqlField:
    | "createIssue"
    | "createPullRequest"
    | "updateIssue"
    | "updatePullRequest";
  method: "PATCH" | "POST";
  operation:
    | "github.issue.create"
    | "github.issue.update"
    | "github.pull.create"
    | "github.pull.update";
  restPath: RegExp;
};

const GITHUB_BODY_WRITES = [
  {
    denialMessage: `GitHub issue creation must use the github_createIssue tool so Junior can own idempotency and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "createIssue",
    method: "POST",
    operation: "github.issue.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues$/,
  },
  {
    denialMessage: `GitHub pull request creation must use the github_createPullRequest tool so Junior can own idempotency and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "createPullRequest",
    method: "POST",
    operation: "github.pull.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/pulls$/,
  },
  {
    denialMessage: `GitHub issue updates must use the github_updateIssue tool so Junior can own requester attribution and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "updateIssue",
    method: "PATCH",
    operation: "github.issue.update",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+$/,
  },
  {
    denialMessage: `GitHub pull request updates must use the github_updatePullRequest tool so Junior can own requester attribution and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "updatePullRequest",
    method: "PATCH",
    operation: "github.pull.update",
    restPath: /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/,
  },
] as const satisfies readonly GitHubBodyWrite[];

function githubApiWriteGrantName(
  method: string,
  upstreamUrl: URL,
): "installation-write" | "user-write" | undefined {
  const pathname = upstreamUrl.pathname.toLowerCase();
  if (!isGitHubApiUrl(upstreamUrl)) {
    return undefined;
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches$/.test(
      pathname,
    )
  ) {
    return "installation-write";
  }
  if (
    method === "POST" &&
    (/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/[^/]+\/(cancel|rerun|rerun-failed-jobs)$/.test(
      pathname,
    ) ||
      /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/[^/]+\/rerun$/.test(pathname))
  ) {
    // Actions run control uses run-level cancel/rerun and job-level rerun endpoints.
    return "installation-write";
  }
  if (
    GITHUB_BODY_WRITES.some(
      (write) => write.method === method && write.restPath.test(pathname),
    )
  ) {
    return "installation-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/.test(pathname)
  ) {
    return "installation-write";
  }
  if (
    (method === "POST" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/(labels|assignees)(?:\/[^/]+)?$/.test(
      pathname,
    )
  ) {
    return "installation-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/ready_for_review$/.test(pathname)
  ) {
    return "installation-write";
  }
  if (
    (method === "POST" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/requested_reviewers$/.test(pathname)
  ) {
    return "installation-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/comments(?:\/[^/]+\/replies)?$/.test(
      pathname,
    )
  ) {
    // Inline review comments and thread replies post as the App bot.
    return "installation-write";
  }
  if (
    (method === "PATCH" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/[^/]+$/.test(pathname)
  ) {
    // Update/delete of inline review comments also stay bot-owned.
    return "installation-write";
  }
  if (
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews(?:\/[^/]+(?:\/(events|dismissals))?)?$/.test(
      pathname,
    ) &&
    !HTTP_READ_METHODS.has(method)
  ) {
    // Bot-authored reviews use the App installation identity so headless and
    // interactive review feedback both post as Junior, not the requesting user.
    return "installation-write";
  }
  return undefined;
}

function isGitHubGraphqlMutation(
  method: string,
  upstreamUrl: URL,
  bodyText: string | undefined,
  field:
    | "createIssue"
    | "createPullRequest"
    | "updateIssue"
    | "updatePullRequest",
): boolean {
  if (method !== "POST" || !isGitHubGraphqlUrl(upstreamUrl)) return false;
  const parsed = parseGitHubGraphqlRequest(bodyText);
  if (!parsed || !new RegExp(`\\b${field}\\b`).test(parsed.normalized)) {
    return false;
  }
  if (!parsed.operationName) return /\bmutation\b/.test(parsed.normalized);
  return new RegExp(
    `\\bmutation\\s+${escapeRegExp(parsed.operationName)}\\b`,
  ).test(parsed.normalized);
}

function applyGitHubEgressPolicy(input: {
  bodyText?: string;
  method: string;
  operation?: string;
  upstreamUrl: URL;
}): void {
  assertGitHubPullRequestApprovalDenied({
    ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
    method: input.method,
    upstreamUrl: input.upstreamUrl,
  });

  const pathname = input.upstreamUrl.pathname.toLowerCase();
  const write = GITHUB_BODY_WRITES.find(
    (candidate) =>
      (candidate.method === input.method &&
        isGitHubApiUrl(input.upstreamUrl) &&
        candidate.restPath.test(pathname)) ||
      isGitHubGraphqlMutation(
        input.method,
        input.upstreamUrl,
        input.bodyText,
        candidate.graphqlField,
      ),
  );
  if (!write) return;

  enforceEgressPolicy({
    allowed: input.operation === write.operation,
    denialMessage: write.denialMessage,
  });
}

function grantForAccess(
  access: PluginGrantAccess,
  reason: GitHubGrantReason,
  name: GitHubGrantName,
  leaseScope?: string,
): GitHubGrant {
  return {
    name,
    access,
    ...(leaseScope ? { leaseScope } : {}),
    reason,
    ...(name === "user-write" ? { requirements: USER_WRITE_REQUIREMENTS } : {}),
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

async function githubGrantForEgress(
  ctx: EgressHookContext,
): Promise<GitHubGrant> {
  const method = ctx.request.method.toUpperCase();
  const upstreamUrl = new URL(ctx.request.url);
  applyGitHubEgressPolicy({
    ...(ctx.request.bodyText !== undefined
      ? { bodyText: ctx.request.bodyText }
      : {}),
    method,
    ...(ctx.request.operation ? { operation: ctx.request.operation } : {}),
    upstreamUrl,
  });
  if (isGitHubAssetUploadRequest(method, upstreamUrl)) {
    return grantForAccess("write", "github.asset-upload", "user-write");
  }

  const smartHttpAccess = githubSmartHttpAccess(upstreamUrl);
  if (smartHttpAccess) {
    if (smartHttpAccess === "write") {
      return grantForAccess(
        "write",
        "github.installation-write",
        "installation-write",
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

  const writeGrantName = githubApiWriteGrantName(method, upstreamUrl);
  if (writeGrantName) {
    return grantForAccess(
      "write",
      writeGrantName === "user-write"
        ? "github.user-write"
        : "github.installation-write",
      writeGrantName,
      repositoryLeaseScope(upstreamUrl),
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
  const declaredAppPermissions = normalizePermissions(options.appPermissions);
  const declaredReadPermissions = declaredAppPermissions
    ? readGrantPermissions(declaredAppPermissions)
    : undefined;
  const loadReadPermissions = createPermissionCache();
  const userScopes = normalizeScopeList(options.additionalUserScopes);
  const userScope = userScopes.length ? userScopes.join(" ") : undefined;

  return defineJuniorPlugin({
    packageName: "@sentry/junior-github",
    resourceEvents: {
      resourceTypes: [
        {
          type: "deployment_source",
          supportedEvents: [...GITHUB_DEPLOYMENT_EVENTS],
          suggestedEvents: [...GITHUB_DEPLOYMENT_SUGGESTED_EVENTS],
        },
        {
          type: "issue",
          supportedEvents: [...GITHUB_ISSUE_EVENTS],
          suggestedEvents: [...GITHUB_ISSUE_SUGGESTED_EVENTS],
        },
        {
          type: "pull_request",
          supportedEvents: [...GITHUB_PULL_REQUEST_EVENTS],
          suggestedEvents: [...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS],
        },
        {
          type: "release_source",
          supportedEvents: [...GITHUB_RELEASE_EVENTS],
          suggestedEvents: [...GITHUB_RELEASE_SUGGESTED_EVENTS],
        },
        {
          type: "repository",
          supportedEvents: [
            ...GITHUB_ISSUE_EVENTS,
            ...GITHUB_PULL_REQUEST_EVENTS,
          ],
          suggestedEvents: [
            "issue.opened",
            "pull_request.opened",
            ...GITHUB_ISSUE_SUGGESTED_EVENTS,
            ...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
          ],
        },
      ],
      isEnabled: () => Boolean(readEnv("GITHUB_WEBHOOK_SECRET")),
      normalizeIdentifier: (identifier) => identifier.toLowerCase(),
    },
    manifest: {
      name: "github",
      displayName: "GitHub",
      description:
        "GitHub deployment, issue, pull request, release, and repository workflows via GitHub App",
      configKeys: ["org", "repo"],
      domains: ["api.github.com", "github.com", "uploads.github.com"],
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
        {
          type: "system",
          package: "jq",
        },
      ],
    },
    hooks: {
      conversationSidebar(ctx) {
        return {
          annotationsByConversationId: Object.fromEntries(
            ctx.conversationIds.flatMap((conversationId) => {
              const annotations = githubSidebarAnnotations(
                ctx.annotationsByConversationId[conversationId] ?? [],
              );
              return annotations.length > 0
                ? [[conversationId, annotations]]
                : [];
            }),
          ),
        };
      },
      formatMarkdown({ text }) {
        return linkifyGitHubReferences(text);
      },
      async unfinishedWork(ctx) {
        const db = ctx.db as GitHubDb;
        const [
          conversationIds,
          assignedConversationIds,
          finishedWorkAtByConversationId,
        ] = await Promise.all([
          listGitHubUnfinishedWork(db, ctx.conversationIds),
          listGitHubAssignedWork(db, ctx.conversationIds),
          listGitHubFinishedWork(db, ctx.conversationIds),
        ]);
        return {
          conversationIds,
          assignedConversationIds,
          finishedWorkAtByConversationId,
        };
      },
      routes(ctx) {
        return [
          createGitHubWebhookRoute({
            annotations: ctx.annotations,
            botEmail: () => readEnv(botEmailEnv),
            classifyPullRequestCommits: async ({
              number,
              repositoryFullName,
            }) => {
              const [owner, name, ...extra] = repositoryFullName.split("/");
              if (!owner || !name || extra.length > 0) {
                throw new Error(
                  "GitHub pull request commit classification received an invalid repository name",
                );
              }
              const token = await issueInstallationToken({
                appIdEnv,
                privateKeyEnv,
                installationIdEnv,
                permissions: { pull_requests: "read" },
                repositories: [name],
              });
              return await classifyGitHubPullRequestCommitComposition({
                botEmail: requireEnv(botEmailEnv),
                loadPage: async (page, perPage) =>
                  await githubRequest(
                    "https://api.github.com",
                    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/commits?per_page=${perPage}&page=${page}`,
                    { token: token.token },
                  ),
              });
            },
            db: ctx.db as GitHubDb,
            installationId: () => readEnv(installationIdEnv),
            loadFailingChecks: async (body) =>
              await loadFailingChecksForSuite({
                appIdEnv,
                body,
                installationIdEnv,
                log: ctx.log,
                privateKeyEnv,
              }),
            log: ctx.log,
            resourceEvents: ctx.resourceEvents,
            webhookSecret: () => readEnv("GITHUB_WEBHOOK_SECRET"),
          }),
        ];
      },
      async operationalReport(ctx) {
        return await buildGitHubOutcomeReport({
          db: ctx.db as GitHubDb,
          nowMs: ctx.nowMs,
        });
      },
      async profileReport(ctx) {
        return await buildGitHubProfileReport({
          db: ctx.db as GitHubDb,
          nowMs: ctx.nowMs,
          userId: ctx.subject.id,
        });
      },
      tools(ctx) {
        return createGitHubTools(ctx);
      },
      async workspacePrepare(ctx) {
        const repos = ctx.repos.map((entry) => {
          const [owner, name, ...rest] = entry.repo.split("/");
          if (!owner || !name || rest.length > 0) {
            throw new Error(`Invalid GitHub repository: ${entry.repo}`);
          }
          const segments = entry.path.split("/");
          if (
            segments.length === 0 ||
            segments.some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                !/^[A-Za-z0-9._-]+$/.test(part),
            ) ||
            isReservedSandboxDirectory(segments[0]!)
          ) {
            throw new Error(`Invalid workspace checkout path: ${entry.path}`);
          }
          return { owner, name, path: entry.path, repo: entry.repo };
        });
        const paths = new Set<string>();
        for (const entry of repos) {
          const key = entry.path.toLowerCase();
          if (paths.has(key)) {
            throw new Error(
              `Workspace checkout path collision: ${entry.path}`,
            );
          }
          paths.add(key);
        }
        for (const { owner, name, path, repo } of repos) {
          const parent = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : undefined;
          if (parent) {
            const mkdir = await ctx.sandbox.run({
              cmd: "mkdir",
              args: ["-p", "--", parent],
              cwd: ctx.sandbox.root,
            });
            if (mkdir.exitCode !== 0) {
              throw new Error(
                `GitHub workspace checkout parent failed for ${repo}: ${mkdir.stderr.trim() || `exit ${mkdir.exitCode}`}`,
              );
            }
          }
          const result = await ctx.sandbox.run({
            cmd: "git",
            args: [
              "clone",
              "--quiet",
              "--depth=1",
              "--",
              `https://github.com/${owner}/${name}.git`,
              path,
            ],
            cwd: ctx.sandbox.root,
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `GitHub workspace clone failed for ${repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
            );
          }
        }
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
              ...(declaredReadPermissions
                ? { permissions: declaredReadPermissions }
                : { loadPermissions: loadReadPermissions }),
            });
          }
          if (ctx.grant.name === "installation-write") {
            const repository = githubRepositoryFromLeaseScope(
              ctx.grant.leaseScope,
            );
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
              // This repository-only variant cannot downscope the installed
              // App envelope with an operation-specific permission body.
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
