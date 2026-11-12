import * as z from "zod";
import {
  GITHUB_SESSION_FOOTER_START,
  githubConversationIds,
  githubLinkedIssues,
} from "../tools/footer.js";
import type {
  GitHubPullRequestConversationsInput,
  GitHubPullRequestLinkedIssuesInput,
  GitHubPullRequestOutcomeInput,
} from "../pull-request-outcomes/store.js";
import { botLoginFromEmail, isBotLogin } from "./ownership.js";

// `ready_for_review` and `converted_to_draft` change only the draft state.
const pullRequestLifecycleActionsSchema = z.enum([
  "opened",
  "closed",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
]);

const canonicalPullRequestOutcomeSchema = z
  .object({
    action: pullRequestLifecycleActionsSchema,
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        draft: z.boolean().optional(),
        id: z.number().int().positive(),
        merged: z.boolean(),
        merged_at: z.string().nullable().optional(),
        number: z.number().int().positive(),
        title: z.string().min(1).optional(),
        updated_at: z.string(),
        user: z.object({ login: z.string().min(1) }).strict(),
      })
      .strict(),
    repository: z
      .object({
        full_name: z.string().min(1),
        id: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const pullRequestOutcomeSchema = z
  .object({
    action: pullRequestLifecycleActionsSchema,
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        draft: z.boolean().optional(),
        id: z.number().int().positive(),
        merged: z.boolean(),
        merged_at: z.string().nullable().optional(),
        number: z.number().int().positive(),
        title: z.string().min(1).optional(),
        updated_at: z.string(),
        user: z.object({ login: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
    repository: z
      .object({
        full_name: z.string().min(1),
        id: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((provider) =>
    canonicalPullRequestOutcomeSchema.parse({
      action: provider.action,
      pull_request: {
        body: provider.pull_request.body,
        closed_at: provider.pull_request.closed_at,
        created_at: provider.pull_request.created_at,
        draft: provider.pull_request.draft,
        id: provider.pull_request.id,
        merged: provider.pull_request.merged,
        merged_at: provider.pull_request.merged_at,
        number: provider.pull_request.number,
        title: provider.pull_request.title,
        updated_at: provider.pull_request.updated_at,
        user: { login: provider.pull_request.user.login },
      },
      repository: {
        full_name: provider.repository.full_name,
        id: provider.repository.id,
      },
    }),
  );

const pullRequestLifecycleActionSchema = z
  .object({ action: z.string() })
  .passthrough();
const canonicalPullRequestConversationSchema = z
  .object({
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        id: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).strict(),
      })
      .strict(),
    repository: z.object({ full_name: z.string().min(1) }).strict(),
    sender: z.object({ login: z.string().min(1) }).strict(),
  })
  .strict();

const pullRequestConversationSchema = z
  .object({
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        id: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
    repository: z.object({ full_name: z.string().min(1) }).passthrough(),
    sender: z.object({ login: z.string().min(1) }).passthrough(),
  })
  .passthrough()
  .transform((provider) =>
    canonicalPullRequestConversationSchema.parse({
      pull_request: {
        body: provider.pull_request.body,
        id: provider.pull_request.id,
        user: { login: provider.pull_request.user.login },
      },
      repository: { full_name: provider.repository.full_name },
      sender: { login: provider.sender.login },
    }),
  );

/** Parse a provider timestamp. A missing or invalid value is undefined. */
function timestamp(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

/** Normalize only the fields required for the Junior-owned PR projection. */
export function normalizeGitHubPullRequestOutcome(args: {
  body: unknown;
  botEmail?: string;
}): GitHubPullRequestOutcomeInput | undefined {
  const lifecycle = pullRequestLifecycleActionSchema.safeParse(args.body);
  if (
    !lifecycle.success ||
    !pullRequestLifecycleActionsSchema.safeParse(lifecycle.data.action).success
  ) {
    return undefined;
  }
  const parsed = pullRequestOutcomeSchema.parse(args.body);
  const pullRequest = parsed.pull_request;
  const openedAt = timestamp(pullRequest.created_at);
  const updatedAt = timestamp(pullRequest.updated_at);
  if (!openedAt || !updatedAt) {
    throw new Error("GitHub pull request lifecycle timestamps are invalid");
  }
  if (parsed.action === "opened" && !botLoginFromEmail(args.botEmail)) {
    throw new Error(
      "The configured GitHub App bot email must encode a [bot] login in GitHub's noreply format to classify pull request ownership",
    );
  }
  const hasOwnershipMarker = Boolean(
    isBotLogin(pullRequest.user.login, args.botEmail) &&
    pullRequest.body?.includes(GITHUB_SESSION_FOOTER_START),
  );
  const candidateOwned =
    hasOwnershipMarker &&
    (parsed.action === "opened" || parsed.action === "closed");
  const state =
    parsed.action !== "closed"
      ? "open"
      : pullRequest.merged
        ? "merged"
        : "closed_unmerged";
  // A close without a valid terminal time is still a close. Use the update
  // time, so the pull request does not stay open in Junior.
  const closed = parsed.action === "closed";
  const closedAt =
    timestamp(pullRequest.closed_at) ?? (closed ? updatedAt : undefined);
  const mergedAt =
    timestamp(pullRequest.merged_at) ??
    (closed && pullRequest.merged ? updatedAt : undefined);
  return {
    candidateOwned,
    closedAt,
    // A close keeps the stored draft state.
    draft: closed ? undefined : pullRequest.draft,
    mergedAt,
    number: pullRequest.number,
    openedAt,
    pullRequestId: String(pullRequest.id),
    repositoryFullName: parsed.repository.full_name,
    repositoryId: String(parsed.repository.id),
    state,
    title: pullRequest.title,
    updatedAt,
  };
}

/** Normalize native conversation ids written to a Junior-owned PR by its bot. */
export function normalizeGitHubPullRequestConversations(args: {
  body: unknown;
  botEmail?: string;
}): GitHubPullRequestConversationsInput | undefined {
  const parsed = pullRequestConversationSchema.safeParse(args.body);
  if (!parsed.success) return undefined;
  if (
    !isBotLogin(parsed.data.pull_request.user.login, args.botEmail) ||
    !isBotLogin(parsed.data.sender.login, args.botEmail)
  ) {
    return undefined;
  }
  const conversationIds = githubConversationIds(parsed.data.pull_request.body);
  return conversationIds.length > 0
    ? {
        conversationIds,
        pullRequestId: String(parsed.data.pull_request.id),
      }
    : undefined;
}

/** Normalize linked issues written into a Junior-owned PR body by its bot. */
export function normalizeGitHubPullRequestLinkedIssues(args: {
  body: unknown;
  botEmail?: string;
}): GitHubPullRequestLinkedIssuesInput | undefined {
  const parsed = pullRequestConversationSchema.safeParse(args.body);
  if (!parsed.success) return undefined;
  if (
    !isBotLogin(parsed.data.pull_request.user.login, args.botEmail) ||
    !isBotLogin(parsed.data.sender.login, args.botEmail)
  ) {
    return undefined;
  }
  const linkedIssues = githubLinkedIssues(
    parsed.data.pull_request.body,
    parsed.data.repository.full_name,
  );
  return linkedIssues.length > 0
    ? {
        linkedIssues,
        pullRequestId: String(parsed.data.pull_request.id),
      }
    : undefined;
}
