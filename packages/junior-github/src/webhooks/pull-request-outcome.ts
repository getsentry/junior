import { z } from "zod";
import { GITHUB_SESSION_FOOTER_START } from "../tools/footer.js";
import type { GitHubPullRequestOutcomeInput } from "../pull-request-outcomes/store.js";

const pullRequestOutcomeSchema = z.object({
  action: z.enum(["opened", "closed", "reopened"]),
  pull_request: z.object({
    body: z.string().nullable().optional(),
    closed_at: z.string().nullable().optional(),
    created_at: z.string(),
    id: z.number().int().positive(),
    merged: z.boolean(),
    merged_at: z.string().nullable().optional(),
    number: z.number().int().positive(),
    updated_at: z.string(),
    user: z.object({ login: z.string().min(1) }),
  }),
  repository: z.object({
    full_name: z.string().min(1),
    id: z.number().int().positive(),
  }),
});

const pullRequestLifecycleActionSchema = z.object({ action: z.string() });
const GITHUB_NOREPLY_DOMAIN = "users.noreply.github.com";

/** Derive the provider login encoded in a standard GitHub noreply address. */
function botLoginFromEmail(value: string | undefined): string | undefined {
  const email = value?.trim();
  if (!email) return undefined;
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const domain = email.slice(separator + 1).toLowerCase();
  if (domain !== GITHUB_NOREPLY_DOMAIN) return undefined;
  const localPart = email.slice(0, separator);
  const login = localPart.slice(localPart.indexOf("+") + 1).trim();
  return login.toLowerCase().endsWith("[bot]") ? login : undefined;
}

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
    !["opened", "closed", "reopened"].includes(lifecycle.data.action)
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
