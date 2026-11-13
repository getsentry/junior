/**
 * GitHub egress policy and grant selection.
 *
 * Owns which GitHub requests Junior may make and which credential grant
 * each request needs. Junior-owned issue, pull request, review, and push
 * writes never fall back to user OAuth. Merge, fork, branch deletion, REST ref
 * writes, and administration stay unsupported; unknown REST writes and
 * GraphQL mutations are denied. Only the repository create tool may create a
 * repository. Git pushes never touch the default branch.
 */
import {
  EgressPolicyDenied,
  enforceEgressPolicy,
  type EgressHookContext,
  type EgressResponseHookContext,
  type PluginGrantAccess,
  type PluginGraphqlOperation,
  type PluginGraphqlRequest,
} from "@sentry/junior-plugin-api";
import { assertGitHubPullRequestApprovalDenied } from "./pull-request-review-policy.js";
import { assertGitHubPushAllowed } from "./receive-pack-policy.js";
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";
import {
  CREATE_TOOL_ROUTING_GUIDANCE,
  GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
  HTTP_READ_METHODS,
  USER_WRITE_REQUIREMENTS,
  githubRepositoryFromUrl,
  isRecord,
  type GitHubGrant,
  type GitHubGrantName,
  type GitHubRepository,
  type GitHubGrantReason,
} from "./credential-support.js";

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

/**
 * Return the one operation of a GitHub GraphQL POST. GitHub runs no batches,
 * so a batch, like an unreadable body, has no operation.
 */
function githubGraphqlOperation(
  graphql: PluginGraphqlRequest | undefined,
): PluginGraphqlOperation | undefined {
  return graphql?.kind === "operation" ? graphql.operation : undefined;
}

function githubGraphqlAccess(
  method: string,
  upstreamUrl: URL,
  graphql: PluginGraphqlRequest | undefined,
): PluginGrantAccess | undefined {
  if (!isGitHubGraphqlUrl(upstreamUrl)) {
    return undefined;
  }
  if (HTTP_READ_METHODS.has(method)) {
    return "read";
  }
  // A POST without one readable query is a write, which the caller denies
  // rather than issue an installation or user credential.
  return githubGraphqlOperation(graphql)?.type === "query" ? "read" : "write";
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

const GITHUB_ERROR_BODY_LIMIT_BYTES = 4 * 1024;

// GitHub also returns 403 for requests it refuses for other reasons, such as
// a run that cannot be retried or a secondary rate limit. Only this message
// means that the App or user token lacks access.
const GITHUB_ACCESS_DENIED_MESSAGE = "Resource not accessible by integration";

// GitHub sends this header on most responses. It lists the permissions that
// the endpoint accepts. It does not say which permission is missing.
const GITHUB_ACCEPTED_PERMISSIONS_PATTERN =
  /^[a-z_]+=[a-z]+(?:\s*[,;]\s*[a-z_]+=[a-z]+)*$/;

function githubErrorMessage(bodyText: string | undefined): string | undefined {
  if (!bodyText) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return isRecord(parsed) && typeof parsed.message === "string"
      ? parsed.message.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function githubForbiddenPermissionDeniedMessage(
  ctx: EgressResponseHookContext,
): Promise<string | undefined> {
  const sso = ctx.response.headers.get("x-github-sso");
  if (sso?.startsWith("required")) {
    // The header looks like `required; url=https://github.com/orgs/...`.
    const url = sso
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("url="))
      ?.slice("url=".length);
    if (url && URL.parse(url)?.origin !== "https://github.com") {
      return "GitHub requires SAML SSO authorization for this credential.";
    }
    return `GitHub requires SAML SSO authorization for this credential.${url ? ` Authorize it at ${url}` : ""}`;
  }
  const message = githubErrorMessage(
    await ctx.response.readText(GITHUB_ERROR_BODY_LIMIT_BYTES),
  );
  if (message !== GITHUB_ACCESS_DENIED_MESSAGE) {
    return undefined;
  }
  const accepted = ctx.response.headers
    .get("x-accepted-github-permissions")
    ?.trim();
  return [
    `GitHub denied access: ${message}.`,
    ...(accepted && GITHUB_ACCEPTED_PERMISSIONS_PATTERN.test(accepted)
      ? [`This endpoint accepts these GitHub permissions: ${accepted}.`]
      : []),
  ].join(" ");
}

/**
 * Classify a GitHub response as a permission denial.
 *
 * Returns a message only when GitHub says that the credential lacks access.
 * Other GitHub refusals return undefined, so the runtime does not call them
 * permission problems.
 */
export async function githubPermissionDeniedMessage(
  ctx: EgressResponseHookContext,
): Promise<string | undefined> {
  if (ctx.response.status === 403) {
    return await githubForbiddenPermissionDeniedMessage(ctx);
  }
  if (!shouldInspectGitHubGraphqlResponse(ctx)) {
    return undefined;
  }
  const bodyText = await ctx.response.readText(
    GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
  );
  return bodyText ? githubGraphqlPermissionDeniedMessage(bodyText) : undefined;
}

/** GitHub body writes that must go through a typed tool. */
type GitHubBodyWrite = {
  denialMessage: string;
  graphqlField:
    | "createIssue"
    | "createPullRequest"
    | "addPullRequestReview"
    | "addPullRequestReviewThreadReply"
    | "updateIssue"
    | "updatePullRequest";
  method: "PATCH" | "POST";
  operation:
    | "github.issue.create"
    | "github.issue.update"
    | "github.pull.comment.create"
    | "github.pull.create"
    | "github.pull.review.create"
    | "github.pull.update";
  restPath: RegExp;
};

const ISSUE_PATH = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/;
const ISSUE_READ_DENIAL = `Use github_getIssue to read a GitHub issue, not gh issue view or gh api. Read comments with gh api repos/OWNER/REPO/issues/NUMBER/comments. ${CREATE_TOOL_ROUTING_GUIDANCE}`;

/** Match one-issue reads: the REST issue path or a GraphQL issue field. */
function isGitHubIssueRead(input: {
  graphql?: PluginGraphqlRequest;
  method: string;
  upstreamUrl: URL;
}): boolean {
  if (isGitHubGraphqlUrl(input.upstreamUrl)) {
    // `gh issue view` selects `issue(number:)` or `issueOrPullRequest(number:)`.
    const operation =
      input.method === "POST"
        ? githubGraphqlOperation(input.graphql)
        : undefined;
    return (
      operation?.fields.some(
        (field) =>
          (field.name === "issue" || field.name === "issueOrPullRequest") &&
          field.arguments.length > 0,
      ) ?? false
    );
  }
  return (
    isGitHubApiUrl(input.upstreamUrl) &&
    HTTP_READ_METHODS.has(input.method) &&
    ISSUE_PATH.test(input.upstreamUrl.pathname.toLowerCase())
  );
}

const PULL_REQUEST_COMMENT_REACTIONS_PATH =
  /^\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/comments\/[^/]+\/reactions(?:\/[^/]+)?$/;

/**
 * REST writes that only the tool that owns them may send. Sandbox requests
 * carry no egress operation, so they stay denied. The comment edit tool also
 * checks that the bot posted the comment, which the endpoint does not.
 */
const TOOL_ONLY_REST_WRITES = [
  {
    denialMessage:
      "GitHub issue comment edits must use the github_updateIssueComment tool, which only edits comments the bot posted.",
    method: "PATCH",
    operation: "github.issue.comment.update",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/,
  },
  {
    denialMessage:
      "Reactions on a GitHub issue or pull request must use the github_reactToIssue tool.",
    method: "POST",
    operation: "github.issue.reaction.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions$/,
  },
] as const;

function toolOnlyRestWrite(method: string, upstreamUrl: URL) {
  if (!isGitHubApiUrl(upstreamUrl)) return undefined;
  const pathname = upstreamUrl.pathname.toLowerCase();
  return TOOL_ONLY_REST_WRITES.find(
    (write) => write.method === method && write.restPath.test(pathname),
  );
}

const GITHUB_BODY_WRITES = [
  {
    denialMessage: `GitHub issue creation must use the github_createIssue tool, which owns idempotency and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "createIssue",
    method: "POST",
    operation: "github.issue.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues$/,
  },
  {
    denialMessage: `GitHub pull request creation must use the github_createPullRequest tool, which owns idempotency and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "createPullRequest",
    method: "POST",
    operation: "github.pull.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/pulls$/,
  },
  {
    denialMessage: `GitHub pull request reviews must use the github_submitPullRequestReview tool. The tool posts to /repos/{owner}/{repo}/pulls/{number}/reviews. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "addPullRequestReview",
    method: "POST",
    operation: "github.pull.review.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews$/,
  },
  {
    denialMessage: `GitHub review thread replies must use the github_commentOnPullRequest tool with in_reply_to. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "addPullRequestReviewThreadReply",
    method: "POST",
    operation: "github.pull.comment.create",
    restPath: /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/comments\/[^/]+\/replies$/,
  },
  {
    denialMessage: `GitHub issue updates must use the github_updateIssue tool, which owns requester attribution and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
    graphqlField: "updateIssue",
    method: "PATCH",
    operation: "github.issue.update",
    restPath: /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+$/,
  },
  {
    denialMessage: `GitHub pull request updates must use the github_updatePullRequest tool, which owns requester attribution and the conversation footer. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
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
    (method === "POST" || method === "DELETE") &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/requested_reviewers$/.test(pathname)
  ) {
    return "installation-write";
  }
  if (
    method === "POST" &&
    /^\/repos\/[^/]+\/[^/]+\/stacks(?:\/[^/]+\/(add|unstack))?$/.test(pathname)
  ) {
    // Stack create/add/unstack writes carry only PR numbers. PR creation and
    // base or draft changes stay with the typed pull request tools.
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
  if (
    (method === "POST" || method === "DELETE") &&
    PULL_REQUEST_COMMENT_REACTIONS_PATH.test(pathname)
  ) {
    // Feedback-status reactions on conversation and inline review comments.
    return "installation-write";
  }
  if (toolOnlyRestWrite(method, upstreamUrl)) {
    return "installation-write";
  }
  return undefined;
}

/**
 * GraphQL writes that host tools may send. A request matches only when its
 * egress operation starts with the prefix and its operation name and mutation
 * field match. Sandbox requests have no egress operation, so they stay denied.
 */
const HOST_GRAPHQL_MUTATIONS = [
  {
    field: "resolveReviewThread",
    operationName: "ResolveReviewThread",
    operationPrefix: "github.pull.review-thread.resolve:",
  },
  {
    field: "markPullRequestReadyForReview",
    operationName: "MarkPullRequestReadyForReview",
    operationPrefix: "github.pull.draft.update:",
  },
  {
    field: "convertPullRequestToDraft",
    operationName: "ConvertPullRequestToDraft",
    operationPrefix: "github.pull.draft.update:",
  },
  // Feedback-status reactions on review bodies, which have no REST endpoint.
  {
    field: "addReaction",
    operationName: "AddReviewReaction",
    operationPrefix: "github.pull.review-reaction.update:",
  },
  {
    field: "removeReaction",
    operationName: "RemoveReviewReaction",
    operationPrefix: "github.pull.review-reaction.update:",
  },
] as const;

function hostGraphqlMutationRepository(
  operation: string | undefined,
  method: string,
  upstreamUrl: URL,
  graphql: PluginGraphqlRequest | undefined,
): string | undefined {
  if (method !== "POST" || !isGitHubGraphqlUrl(upstreamUrl) || !operation) {
    return undefined;
  }
  const parsed = githubGraphqlOperation(graphql);
  const mutation = HOST_GRAPHQL_MUTATIONS.find(
    (candidate) =>
      operation.startsWith(candidate.operationPrefix) &&
      parsed?.type === "mutation" &&
      parsed.name === candidate.operationName &&
      parsed.rootFields.length === 1 &&
      parsed.rootFields[0] === candidate.field,
  );
  if (!mutation) return undefined;
  const repository = operation.slice(mutation.operationPrefix.length);
  return /^[^/]+\/[^/]+$/.test(repository) ? repository : undefined;
}

function isGitHubGraphqlMutation(
  method: string,
  upstreamUrl: URL,
  graphql: PluginGraphqlRequest | undefined,
  field: GitHubBodyWrite["graphqlField"],
): boolean {
  if (method !== "POST" || !isGitHubGraphqlUrl(upstreamUrl)) return false;
  const parsed = githubGraphqlOperation(graphql);
  return parsed?.type === "mutation" && parsed.rootFields.includes(field);
}

function applyGitHubEgressPolicy(input: {
  bodyText?: string;
  graphql?: PluginGraphqlRequest;
  method: string;
  operation?: string;
  upstreamUrl: URL;
}): void {
  if (
    isGitHubGraphqlUrl(input.upstreamUrl) &&
    input.graphql?.kind === "unreadable" &&
    input.graphql.reason === "too-large"
  ) {
    throw new EgressPolicyDenied(
      "GitHub GraphQL request body is too large to inspect before issuing credentials.",
    );
  }
  const reactionWrite =
    isGitHubApiUrl(input.upstreamUrl) &&
    (input.method === "POST" || input.method === "DELETE") &&
    PULL_REQUEST_COMMENT_REACTIONS_PATH.test(
      input.upstreamUrl.pathname.toLowerCase(),
    );
  if (reactionWrite) {
    const expectedOperation =
      input.method === "POST"
        ? "github.pull.comment-reaction.create"
        : "github.pull.comment-reaction.delete";
    enforceEgressPolicy({
      allowed: input.operation === expectedOperation,
      denialMessage:
        "GitHub pull request feedback reactions must use the github_updatePullRequestFeedback tool.",
    });
  }

  const toolOnlyWrite = toolOnlyRestWrite(input.method, input.upstreamUrl);
  if (toolOnlyWrite) {
    enforceEgressPolicy({
      allowed: input.operation === toolOnlyWrite.operation,
      denialMessage: toolOnlyWrite.denialMessage,
    });
  }

  if (isGitHubIssueRead(input)) {
    enforceEgressPolicy({
      allowed: input.operation === "github.issue.get",
      denialMessage: ISSUE_READ_DENIAL,
    });
  }

  assertGitHubPullRequestApprovalDenied({
    ...(input.bodyText !== undefined
      ? { bodyText: input.bodyText }
      : undefined),
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
        input.graphql,
        candidate.graphqlField,
      ),
  );
  if (!write) return;

  enforceEgressPolicy({
    allowed: input.operation === write.operation,
    denialMessage: write.denialMessage,
  });
}

/** Egress operation prefix of the repository create tool; `owner/name` follows. */
export const GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX =
  "github.repository.create:";

const ORG_REPOSITORY_CREATE_PATH = /^\/orgs\/([^/]+)\/repos$/;

/**
 * Return the `owner/name` of an organization repository create that the
 * repository create tool sent, or undefined when the request is not one.
 * Deny a create from any other caller, such as the sandbox, and one whose
 * URL names another organization than its operation.
 */
function repositoryCreateTarget(input: {
  method: string;
  operation?: string;
  upstreamUrl: URL;
}): string | undefined {
  if (input.method !== "POST" || !isGitHubApiUrl(input.upstreamUrl)) {
    return undefined;
  }
  const org = ORG_REPOSITORY_CREATE_PATH.exec(input.upstreamUrl.pathname)?.[1];
  if (!org) return undefined;
  const target = input.operation?.startsWith(
    GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX,
  )
    ? input.operation.slice(GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX.length)
    : undefined;
  const [owner, name, ...extra] = target?.split("/") ?? [];
  enforceEgressPolicy({
    allowed:
      owner?.toLowerCase() === org.toLowerCase() &&
      Boolean(name) &&
      extra.length === 0,
    denialMessage: `GitHub repository creation must use the github_createRepository tool, which asks the user to confirm each repository. ${CREATE_TOOL_ROUTING_GUIDANCE}`,
  });
  return target;
}

function grantForAccess(
  access: PluginGrantAccess,
  reason: GitHubGrantReason,
  name: GitHubGrantName,
): GitHubGrant {
  return {
    name,
    access,
    reason,
    ...(name === "user-write"
      ? { requirements: USER_WRITE_REQUIREMENTS }
      : undefined),
  };
}

function requireRepositoryTarget(upstreamUrl: URL): GitHubRepository {
  const repository = githubRepositoryFromUrl(upstreamUrl);
  if (repository) {
    return repository;
  }
  throw new EgressPolicyDenied(
    "GitHub write request has no repository in its URL. Use a /repos/{owner}/{repo}/... URL or a GitHub tool for the operation.",
  );
}

/**
 * Select the GitHub grant for one egress request, and name its repository
 * for the write audit event.
 */
export async function githubGrantForEgress(
  ctx: EgressHookContext,
  env: GitHubInstallationEnv,
): Promise<GitHubGrant> {
  const upstreamUrl = new URL(ctx.request.url);
  const grant = await selectGitHubGrant(ctx, env, upstreamUrl);
  const repository = githubRepositoryFromUrl(upstreamUrl);
  return repository
    ? {
        ...grant,
        auditAttributes: {
          ...grant.auditAttributes,
          "app.github.repository": `${repository.owner}/${repository.name}`,
        },
      }
    : grant;
}

async function selectGitHubGrant(
  ctx: EgressHookContext,
  env: GitHubInstallationEnv,
  upstreamUrl: URL,
): Promise<GitHubGrant> {
  const method = ctx.request.method.toUpperCase();
  applyGitHubEgressPolicy({
    ...(ctx.request.bodyText !== undefined
      ? { bodyText: ctx.request.bodyText }
      : undefined),
    ...(ctx.request.graphql ? { graphql: ctx.request.graphql } : undefined),
    method,
    ...(ctx.request.operation
      ? { operation: ctx.request.operation }
      : undefined),
    upstreamUrl,
  });
  if (isGitHubAssetUploadRequest(method, upstreamUrl)) {
    return grantForAccess("write", "github.asset-upload", "user-write");
  }

  const smartHttpAccess = githubSmartHttpAccess(upstreamUrl);
  if (smartHttpAccess) {
    if (smartHttpAccess === "write") {
      const repository = requireRepositoryTarget(upstreamUrl);
      const grant = grantForAccess(
        "write",
        "github.installation-write",
        "installation-write",
      );
      if (
        method !== "POST" ||
        !upstreamUrl.pathname.toLowerCase().endsWith("/git-receive-pack")
      ) {
        return grant;
      }
      return {
        ...grant,
        auditAttributes: await assertGitHubPushAllowed({
          cache: ctx.cache,
          env,
          gitPush: ctx.request.gitPush,
          repository,
        }),
      };
    }
    return grantForAccess(
      smartHttpAccess,
      "github.git-read",
      "installation-read",
    );
  }

  const createdRepository = repositoryCreateTarget({
    method,
    ...(ctx.request.operation
      ? { operation: ctx.request.operation }
      : undefined),
    upstreamUrl,
  });
  if (createdRepository) {
    return {
      ...grantForAccess(
        "write",
        "github.repository-create",
        "installation-repository-create",
      ),
      // The URL names only the organization; the operation names the repo.
      auditAttributes: { "app.github.repository": createdRepository },
    };
  }

  const userReadReason = githubUserReadReason(method, upstreamUrl);
  if (userReadReason) {
    return grantForAccess("read", userReadReason, "user-read");
  }

  const writeGrantName = githubApiWriteGrantName(method, upstreamUrl);
  if (writeGrantName) {
    if (writeGrantName === "installation-write") {
      requireRepositoryTarget(upstreamUrl);
    }
    return grantForAccess(
      "write",
      writeGrantName === "user-write"
        ? "github.user-write"
        : "github.installation-write",
      writeGrantName,
    );
  }

  const hostMutationRepository = hostGraphqlMutationRepository(
    ctx.request.operation,
    method,
    upstreamUrl,
    ctx.request.graphql,
  );
  if (hostMutationRepository) {
    return {
      ...grantForAccess(
        "write",
        "github.installation-write",
        "installation-write",
      ),
      // GraphQL URLs name no repository; the host operation does.
      auditAttributes: { "app.github.repository": hostMutationRepository },
    };
  }

  const graphqlAccess = githubGraphqlAccess(
    method,
    upstreamUrl,
    ctx.request.graphql,
  );
  if (graphqlAccess) {
    if (graphqlAccess === "write") {
      throw new EgressPolicyDenied(
        "GitHub GraphQL mutations are not enabled for runtime credentials. Use the matching GitHub tool or a supported REST endpoint. For pull request reviews, use github_submitPullRequestReview. It posts to /repos/{owner}/{repo}/pulls/{number}/reviews.",
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
      "This GitHub write request is not supported. Use the matching GitHub tool or a supported REST endpoint.",
    );
  }
  return grantForAccess(access, "github.api-read", "installation-read");
}
