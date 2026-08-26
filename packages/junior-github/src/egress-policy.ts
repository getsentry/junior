/**
 * GitHub egress policy and grant selection.
 *
 * Owns which GitHub requests Junior may make and which credential grant
 * each request needs.
 */
import {
  EgressPolicyDenied,
  enforceEgressPolicy,
  type EgressHookContext,
  type EgressResponseHookContext,
  type PluginGrantAccess,
} from "@sentry/junior-plugin-api";
import { assertGitHubPullRequestApprovalDenied } from "./pull-request-review-policy.js";
import {
  CREATE_TOOL_ROUTING_GUIDANCE,
  HTTP_READ_METHODS,
  USER_WRITE_REQUIREMENTS,
  githubRepositoryFromUrl,
  isRecord,
  type GitHubGrant,
  type GitHubGrantName,
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
    ...(operationName ? { operationName } : undefined),
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

export function githubGraphqlPermissionDeniedMessage(
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

export function shouldInspectGitHubGraphqlResponse(
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

function reviewThreadResolveRepository(
  operation: string | undefined,
  method: string,
  upstreamUrl: URL,
  bodyText: string | undefined,
): string | undefined {
  const prefix = "github.pull.review-thread.resolve:";
  if (
    method !== "POST" ||
    !isGitHubGraphqlUrl(upstreamUrl) ||
    !operation?.startsWith(prefix)
  ) {
    return undefined;
  }
  const repository = operation.slice(prefix.length);
  if (!/^[^/]+\/[^/]+$/.test(repository)) return undefined;
  const parsed = parseGitHubGraphqlRequest(bodyText);
  if (
    parsed?.operationName !== "ResolveReviewThread" ||
    !/\bmutation\s+ResolveReviewThread\b/.test(parsed.normalized) ||
    !/\bresolveReviewThread\b/.test(parsed.normalized)
  ) {
    return undefined;
  }
  return repository;
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
    ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : undefined),
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
): GitHubGrant {
  return {
    name,
    access,
    reason,
    ...(name === "user-write" ? { requirements: USER_WRITE_REQUIREMENTS } : undefined),
  };
}

function requireRepositoryTarget(upstreamUrl: URL): void {
  if (githubRepositoryFromUrl(upstreamUrl)) {
    return;
  }
  throw new EgressPolicyDenied(
    "GitHub write request does not identify a target repository.",
  );
}

export async function githubGrantForEgress(
  ctx: EgressHookContext,
): Promise<GitHubGrant> {
  const method = ctx.request.method.toUpperCase();
  const upstreamUrl = new URL(ctx.request.url);
  applyGitHubEgressPolicy({
    ...(ctx.request.bodyText !== undefined
      ? { bodyText: ctx.request.bodyText }
      : undefined),
    method,
    ...(ctx.request.operation ? { operation: ctx.request.operation } : undefined),
    upstreamUrl,
  });
  if (isGitHubAssetUploadRequest(method, upstreamUrl)) {
    return grantForAccess("write", "github.asset-upload", "user-write");
  }

  const smartHttpAccess = githubSmartHttpAccess(upstreamUrl);
  if (smartHttpAccess) {
    if (smartHttpAccess === "write") {
      requireRepositoryTarget(upstreamUrl);
      return grantForAccess(
        "write",
        "github.installation-write",
        "installation-write",
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

  const reviewThreadRepository = reviewThreadResolveRepository(
    ctx.request.operation,
    method,
    upstreamUrl,
    ctx.request.bodyText,
  );
  if (reviewThreadRepository) {
    return grantForAccess(
      "write",
      "github.installation-write",
      "installation-write",
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
        "GitHub GraphQL mutations are not enabled for runtime credentials.",
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
