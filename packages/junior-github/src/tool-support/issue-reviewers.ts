import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import { gitHubDbSchema } from "../db/database.js";
import { requestGitHubIssueReviews } from "../issue-reviewers/items.js";
import { parseGitHubLogin } from "./attribution.js";

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
    // Slack mentions reach the tool as `@login` of the linked account.
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

/**
 * Add a "Review requested" Inbox item for each person whose review a new
 * issue waits on. An item goes only to a person in this Conversation, so
 * the others are left out, with the reason.
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
  const { conversationId, inboxItems } = ctx;
  const inConversation = inboxItems && conversationId;
  const assignable = new Set(
    inConversation && reviewers.length > 0
      ? await inboxItems.assignable(
          reviewers.map((reviewer) => reviewer.identityId),
        )
      : [],
  );
  const requested = reviewers.filter((reviewer) =>
    assignable.has(reviewer.identityId),
  );
  for (const reviewer of reviewers) {
    if (!assignable.has(reviewer.identityId)) {
      leftOut.push({
        person: reviewer.person,
        reason: inConversation
          ? "Is not in this Conversation, so they cannot get an item."
          : "This run has no Conversation, so nobody can get an item.",
      });
    }
  }
  if (inConversation && requested.length > 0) {
    await requestGitHubIssueReviews({
      conversationId,
      db: gitHubDbSchema.parse(ctx.db),
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
