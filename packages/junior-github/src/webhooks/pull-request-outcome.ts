import { z } from "zod";
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
import { botLoginFromEmail } from "./ownership.js";

const canonicalPullRequestOutcomeSchema = z
  .object({
    action: z.enum([
      "opened",
      "closed",
      "reopened",
      "ready_for_review",
      "converted_to_draft",
    ]),
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        draft: z.boolean().default(false),
        id: z.number().int().positive(),
        merged: z.boolean(),
        merged_at: z.string().nullable().optional(),
        number: z.number().int().positive(),
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
    action: z.enum([
      "opened",
      "closed",
      "reopened",
      "ready_for_review",
      "converted_to_draft",
    ]),
    pull_request: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        draft: z.boolean().default(false),
        id: z.number().int().positive(),
        merged: z.boolean(),
        merged_at: z.string().nullable().optional(),
        number: z.number().int().positive(),
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
    repository: z
      .object({ full_name: z.string().min(1) })
      .passthrough(),
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

/** Parse a provider timestamp, rejecting missing or invalid lifecycle values. */
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
    ![
      "opened",
      "closed",
      "reopened",
      "ready_for_review",
      "converted_to_draft",
    ].includes(lifecycle.data.action)
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
  const authorLogin = pullRequest.user.login.trim().toLowerCase();
  const botLogin = botLoginFromEmail(args.botEmail)?.toLowerCase();
  if (parsed.action === "opened" && !botLogin) {
    throw new Error(
      "The configured GitHub App bot email must encode a [bot] login in GitHub's noreply format to classify pull request ownership",
    );
  }
  const hasOwnershipMarker = Boolean(
    botLogin &&
    authorLogin === botLogin &&
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
  const closedAt = timestamp(pullRequest.closed_at);
  const mergedAt = timestamp(pullRequest.merged_at);
  if (
    parsed.action === "closed" &&
    (pullRequest.merged ? !mergedAt : !closedAt)
  ) {
    throw new Error("GitHub pull request terminal timestamp is invalid");
  }
  return {
    candidateOwned,
    closedAt,
    draft: pullRequest.draft,
    mergedAt,
    number: pullRequest.number,
    openedAt,
    pullRequestId: String(pullRequest.id),
    repositoryFullName: parsed.repository.full_name,
    repositoryId: String(parsed.repository.id),
    state,
    updatedAt,
  };
}

/** Normalize native conversation ids written to a Junior-owned PR by its bot. */
export function normalizeGitHubPullRequestConversations(args: {
  body: unknown;
  botEmail?: string;
}): GitHubPullRequestConversationsInput | undefined {
  const parsed = pullRequestConversationSchema.safeParse(args.body);
  const botLogin = botLoginFromEmail(args.botEmail)?.toLowerCase();
  if (!parsed.success || !botLogin) return undefined;
  if (
    parsed.data.pull_request.user.login.trim().toLowerCase() !== botLogin ||
    parsed.data.sender.login.trim().toLowerCase() !== botLogin
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
  const botLogin = botLoginFromEmail(args.botEmail)?.toLowerCase();
  if (!parsed.success || !botLogin) return undefined;
  if (
    parsed.data.pull_request.user.login.trim().toLowerCase() !== botLogin ||
    parsed.data.sender.login.trim().toLowerCase() !== botLogin
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
