import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { requestGitHubIssueReviews } from "../issue-reviewers/items.js";
import { parseGitHubLogin } from "./attribution.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "./github-api.js";

// Each lookup can search Slack, so a long list does not fan out at once.
const PERSON_LOOKUP_CONCURRENCY = 4;

/** A person named for review whom the issue does not wait on, and why. */
export interface LeftOutIssueReviewer {
  person: string;
  reason: string;
}

const LOOKUP_MISS_REASONS = {
  ambiguous: "More than one person matches. Name one person.",
  not_found: "No person matches.",
  unlinked: "Has no linked GitHub account.",
} as const;

/**
 * Turn each named person into their linked GitHub login and Identity. A
 * person whom no linked account verifies is left out, with the reason.
 */
async function resolveReviewers(
  ctx: ToolRegistrationHookContext,
  people: string[],
): Promise<{
  leftOut: LeftOutIssueReviewer[];
  reviewers: Array<{ identityId: string; login: string; person: string }>;
}> {
  const leftOut: LeftOutIssueReviewer[] = [];
  const byLogin = new Map<
    string,
    { identityId: string; login: string; person: string }
  >();
  const lookups = await pLimit(PERSON_LOOKUP_CONCURRENCY).map(
    people,
    // A login is looked up as given. A Slack mention keeps its user ID.
    async (person) => ({
      lookup: await ctx.users.findLinkedHandle(
        parseGitHubLogin(person) ?? person,
        "github",
      ),
      person,
    }),
  );
  for (const { lookup, person } of lookups) {
    const login =
      lookup.status === "found" ? parseGitHubLogin(lookup.handle) : undefined;
    if (lookup.status !== "found" || !login) {
      leftOut.push({
        person,
        reason:
          LOOKUP_MISS_REASONS[
            lookup.status === "found" ? "unlinked" : lookup.status
          ],
      });
      continue;
    }
    byLogin.set(login.toLowerCase(), {
      identityId: lookup.identityId,
      login,
      person,
    });
  }
  return { leftOut, reviewers: [...byLogin.values()] };
}

const assignedIssueSchema = z.object({
  assignees: z.array(z.object({ login: z.string().min(1) })).default([]),
});

/**
 * Assign the reviewers on GitHub, so the issue shows whom it waits on.
 * GitHub skips a person who cannot be assigned in the repo, so only the
 * logins that it assigned are returned.
 */
async function assignReviewers(
  ctx: ToolRegistrationHookContext,
  issue: { number: number; repo: string },
  logins: string[],
): Promise<{ assigned: Set<string>; error?: string }> {
  // This endpoint adds assignees. A PATCH with `assignees` replaces them.
  const response = await githubApi(ctx.egress, {
    operation: "github.issue.assign",
    method: "POST",
    path: `${repoPath(parseRepo(issue.repo))}/issues/${issue.number}/assignees`,
    body: { assignees: logins },
  });
  if (!response.ok) {
    return {
      assigned: new Set(),
      error: `GitHub assignment failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`,
    };
  }
  return {
    assigned: new Set(
      assignedIssueSchema
        .parse(response.body)
        .assignees.map((assignee) => assignee.login.toLowerCase()),
    ),
  };
}

/**
 * Assign each person whose review a new issue waits on, and add a "Review
 * requested" Inbox item for them. An item goes only to a person in this
 * Conversation whom GitHub assigned, so the others are left out, with the
 * reason.
 */
export async function requestIssueReviews(
  ctx: ToolRegistrationHookContext,
  issue: { number: number; repo: string; title: string; url: string },
  people: string[] | undefined,
): Promise<{
  review_left_out?: LeftOutIssueReviewer[];
  review_requested?: string[];
}> {
  if (!people?.length) return {};
  const { leftOut, reviewers } = await resolveReviewers(ctx, people);
  const { inboxItems } = ctx;
  const inConversation = inboxItems && ctx.conversationId;
  const assignable = new Set(
    inConversation && reviewers.length > 0
      ? await inboxItems.assignable(
          reviewers.map((reviewer) => reviewer.identityId),
        )
      : [],
  );
  const candidates = reviewers.filter((reviewer) =>
    assignable.has(reviewer.identityId),
  );
  const assignment =
    inConversation && candidates.length > 0
      ? await assignReviewers(
          ctx,
          issue,
          candidates.map((reviewer) => reviewer.login),
        )
      : { assigned: new Set<string>() };
  const requested = candidates.filter((reviewer) =>
    assignment.assigned.has(reviewer.login.toLowerCase()),
  );
  for (const reviewer of reviewers) {
    if (requested.includes(reviewer)) continue;
    leftOut.push({
      person: reviewer.person,
      reason: !inConversation
        ? "This run has no Conversation, so nobody can get an item."
        : !assignable.has(reviewer.identityId)
          ? "Is not in this Conversation, so they cannot get an item."
          : (assignment.error ??
            `GitHub did not assign @${reviewer.login}. They may not have access to ${issue.repo}.`),
    });
  }
  if (inboxItems && requested.length > 0) {
    await requestGitHubIssueReviews({
      inboxItems,
      issue: {
        number: issue.number,
        repositoryFullName: issue.repo,
        title: issue.title,
        url: issue.url,
      },
      reviewers: requested,
    });
  }
  return {
    ...(leftOut.length > 0 ? { review_left_out: leftOut } : undefined),
    ...(requested.length > 0
      ? { review_requested: requested.map((reviewer) => reviewer.login) }
      : undefined),
  };
}
