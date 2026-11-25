import { githubObjectFacts } from "../object-facts.js";
import { githubObjectAnnotation } from "../annotations.js";
import {
  type Actor,
  type PluginCodeChanges,
  type PluginWorkOwner,
  type PluginLogger,
  type PluginDecider,
  type PluginEgress,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import { gitHubPullRequestSubscribable } from "../events/pull-request.js";
import {
  appendGitHubRequesterAttribution,
  linkedGitHubLogin,
  readGitHubBody,
  requesterPerson,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import type { GitHubDb } from "../db/database.js";
import {
  CONVERT_PULL_REQUEST_TO_DRAFT,
  MARK_PULL_REQUEST_READY_FOR_REVIEW,
  PULL_REQUEST_REVIEWER,
} from "../graphql-documents.js";
import { syncGitHubPullRequestRequesters } from "../pull-request-requesters/code-index.js";
import { recordGitHubPullRequestRequester } from "../pull-request-requesters/store.js";
import { appendGitHubFooter } from "../conversation-footer.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";
import {
  checkPullRequestDescription,
  PULL_REQUEST_BODY_RULES,
} from "../tool-support/pull-request-description.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    pull_request: z.number().int().positive().describe("Pull request number."),
    title: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Replacement pull request title."),
    body: z
      .string()
      .optional()
      .describe(`Replacement pull request body. ${PULL_REQUEST_BODY_RULES}`),
    base: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Replacement base branch."),
    state: z
      .enum(["open", "closed"])
      .optional()
      .describe("Replacement pull request state."),
    draft: z
      .boolean()
      .optional()
      .describe(
        "Set false to mark a draft pull request ready for review, or true to convert it back to a draft.",
      ),
    request_review: z
      .literal(true)
      .optional()
      .describe(
        "Set true to ask only the person who asked for the pull request to review it on GitHub. A draft stays a draft, so nobody else is asked. A person who has reviewed it is not asked again, unless their latest review was dismissed.",
      ),
  })
  .strict()
  .refine(
    ({ title, body, base, state, draft, request_review }) =>
      title !== undefined ||
      body !== undefined ||
      base !== undefined ||
      state !== undefined ||
      draft !== undefined ||
      request_review !== undefined,
    { message: "At least one pull request field must be provided." },
  );

const draftMutationResponseSchema = z.object({
  data: z.object({
    result: z.object({ pullRequest: z.object({ isDraft: z.boolean() }) }),
  }),
});
const pullRequestSchema = z.object({
  base: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type PullRequest = z.output<typeof pullRequestSchema>;
interface Result extends PluginToolOutput, PullRequest {
  review_requested?: boolean;
  target: "updatePullRequest";
  subscribable?: SubscribableResource | undefined;
}
const outputSchema = pluginToolOutputSchema.merge(
  pullRequestSchema.extend({
    review_requested: z
      .boolean()
      .optional()
      .describe(
        "With request_review: true when GitHub asks the person for a review, false when they have reviewed it and their latest review was not dismissed.",
      ),
    target: z.literal("updatePullRequest"),
  }),
);

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(
      `${name} is missing in this Turn, so the GitHub footer cannot be added. No change to the call can fix this.`,
    );
  }
  return value.trim();
}

/** Change draft state through GitHub GraphQL and return the confirmed value. */
async function setPullRequestDraft(input: {
  draft: boolean;
  egress: PluginEgress;
  nodeId: string;
  repo: string;
}): Promise<boolean> {
  const mutation = input.draft
    ? CONVERT_PULL_REQUEST_TO_DRAFT
    : MARK_PULL_REQUEST_READY_FOR_REVIEW;
  const response = await githubApi(input.egress, {
    operation: `github.pull.draft.update:${input.repo.toLowerCase()}`,
    method: "POST",
    path: "/graphql",
    body: {
      ...mutation,
      variables: { id: input.nodeId },
    },
  });
  const payload = response.body;
  const isDraft =
    draftMutationResponseSchema.safeParse(payload).data?.data.result.pullRequest
      .isDraft;
  if (!response.ok || isDraft !== input.draft) {
    throw new Error(
      `GitHub pull request draft update failed with HTTP ${response.status}: ${githubErrorMessage(payload)}`,
    );
  }
  return isDraft;
}

const reviewerSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewRequests: z.object({
          nodes: z.array(
            z.object({
              requestedReviewer: z
                .object({ login: z.string().optional() })
                .nullable(),
            }),
          ),
        }),
        reviews: z.object({ nodes: z.array(z.object({ state: z.string() })) }),
      }),
    }),
  }),
});

/**
 * Ask the requester to review a pull request on GitHub, and return true when
 * GitHub asks them after the call.
 *
 * Junior keeps a draft for its requester when marking it ready would ask the
 * code owners. A review request asks only the person it names, and the Inbox
 * item follows from it (`webhooks/pull-request-action.ts`). A person whom
 * GitHub already asks is not asked again. Nor is a person who has reviewed
 * it, and the result is false: after a change request or a comment-only
 * review, only the review-again flow asks, and an approved draft's item says
 * to mark it ready. An approval stands when a comment follows it. A person
 * with no review yet, or whose latest review was dismissed, is asked.
 */
async function requestRequesterReview(
  egress: PluginEgress,
  repo: { name: string; owner: string },
  number: number,
  login: string,
): Promise<boolean> {
  const read = await githubApi(egress, {
    operation: "github.pull.reviewer.get",
    method: "POST",
    path: "/graphql",
    body: {
      ...PULL_REQUEST_REVIEWER,
      variables: { login, name: repo.name, number, owner: repo.owner },
    },
  });
  const parsed = reviewerSchema.safeParse(read.body);
  if (!read.ok || !parsed.success) {
    const message = `GitHub pull request reviewer lookup failed with HTTP ${read.status}: ${githubErrorMessage(read.body)}`;
    throw new Error(message);
  }
  const { pullRequest } = parsed.data.data.repository;
  const lower = login.toLowerCase();
  if (
    pullRequest.reviewRequests.nodes.some(
      (node) => node.requestedReviewer?.login?.toLowerCase() === lower,
    )
  ) {
    return true;
  }
  const latest = pullRequest.reviews.nodes[0]?.state;
  if (latest && latest !== "DISMISSED") return false;
  const response = await githubApi(egress, {
    operation: "github.pull.request_reviewers",
    method: "POST",
    path: `${repoPath(repo)}/pulls/${number}/requested_reviewers`,
    body: { reviewers: [login] },
  });
  if (!response.ok) {
    const message = `GitHub review request for ${login} failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
    // 422 means GitHub cannot ask this person, such as one without access
    // to the repository.
    if (response.status === 422) {
      throw new PluginToolInputError(
        `${message}. Do not retry: tell them in the thread where they asked.`,
      );
    }
    throw new Error(message);
  }
  return true;
}

/** Update mutable PR metadata while preserving runtime-owned body attribution. */
export function createGitHubUpdatePullRequestTool(
  /** Set when the description check experiment is on. */
  descriptionChecks = false,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Update an existing GitHub pull request's title, body, base branch, open/closed state, or draft state. Use this instead of raw GitHub API calls when changing PR metadata or marking a PR ready for review.",
    inputSchema,
    outputSchema,
    async execute(
      input,
      _options,
      ctx: {
        actor?: Actor | undefined;
        codeChanges: Pick<PluginCodeChanges, "associateRequesters" | "list">;
        conversationId?: string | undefined;
        db: unknown;
        decider: PluginDecider;
        egress: PluginEgress;
        log: PluginLogger;
        events: { canSubscribe: boolean };
        conversationLink?: { url: string };
        resolveWorkOwner(): Promise<PluginWorkOwner | undefined>;
      },
    ): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub updatePullRequest input. Check the arguments against the tool schema and call it again.",
          { cause: parsedInput.error },
        );
      }
      const update = parsedInput.data;
      if (descriptionChecks && update.body !== undefined) {
        await checkPullRequestDescription(ctx.decider, update.body);
      }
      const repo = parseRepo(update.repo);
      const requester = await resolveGitHubRequester(ctx);
      const reviewerLogin = update.request_review
        ? linkedGitHubLogin(requesterPerson(requester)?.user)
        : undefined;
      if (update.request_review && !reviewerLogin) {
        throw new PluginToolInputError(
          "The person who asked for this pull request has no linked GitHub account, so GitHub cannot ask for their review. Do not retry: tell them in the thread where they asked.",
        );
      }
      const currentBody =
        update.body !== undefined
          ? await readGitHubBody(ctx.egress, {
              operation: "github.pull.get",
              path: `${repoPath(repo)}/pulls/${update.pull_request}`,
            })
          : undefined;
      const payload = {
        ...(update.title !== undefined ? { title: update.title } : undefined),
        ...(update.body !== undefined
          ? {
              body: appendGitHubFooter(
                appendGitHubRequesterAttribution(
                  update.body,
                  requester,
                  currentBody,
                ),
                nonEmptyString(ctx.conversationId, "conversationId"),
                ctx.conversationLink?.url,
              ),
            }
          : undefined),
        ...(update.base !== undefined ? { base: update.base } : undefined),
        ...(update.state !== undefined ? { state: update.state } : undefined),
      };
      const hasRestUpdate = Object.keys(payload).length > 0;
      const response = await githubApi(ctx.egress, {
        operation: hasRestUpdate ? "github.pull.update" : "github.pull.get",
        path: `${repoPath(repo)}/pulls/${update.pull_request}`,
        ...(hasRestUpdate ? { method: "PATCH", body: payload } : undefined),
      });
      const parsed = response.body;
      if (!response.ok) {
        const message = `GitHub pull request update failed with HTTP ${response.status}: ${githubErrorMessage(parsed)}`;
        // 404 and 422 mean the model named a missing pull request or GitHub
        // rejected the requested change, such as a base change in a stack.
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(
            `${message}. Check repo and pull_request, and fix any field that GitHub names.`,
          );
        }
        throw new Error(message);
      }
      const providerResult = z
        .object({
          base: z.object({ ref: z.string() }),
          body: z.string().nullable().optional().default(null),
          draft: z.boolean(),
          html_url: z.string(),
          merged: z.boolean(),
          node_id: z.string().optional(),
          number: z.number(),
          state: z.string(),
          title: z.string(),
        })
        .parse(parsed);
      if (update.draft !== undefined && update.draft !== providerResult.draft) {
        if (!providerResult.node_id) {
          throw new Error(
            "GitHub pull request response did not include node_id.",
          );
        }
        providerResult.draft = await setPullRequestDraft({
          draft: update.draft,
          egress: ctx.egress,
          nodeId: providerResult.node_id,
          repo: repo.ref,
        });
      }
      // Like attribution, each person who asks Junior to change the pull
      // request becomes one of its requesters.
      const identity = requesterPerson(requester)?.identity;
      if (identity) {
        const db = ctx.db as GitHubDb;
        await recordGitHubPullRequestRequester(db, {
          identityId: identity.id,
          number: providerResult.number,
          repositoryFullName: repo.ref,
        });
        await syncGitHubPullRequestRequesters({
          codeChanges: ctx.codeChanges,
          db,
          numbers: [providerResult.number],
          repositoryFullName: repo.ref,
        });
      }
      const reviewRequested = reviewerLogin
        ? await requestRequesterReview(
            ctx.egress,
            repo,
            providerResult.number,
            reviewerLogin,
          )
        : undefined;
      const subscribable = gitHubPullRequestSubscribable({
        canSubscribe: ctx.events.canSubscribe,
        number: providerResult.number,
        repo: repo.ref,
      });
      const data: PullRequest = {
        base: providerResult.base.ref,
        body: providerResult.body,
        draft: providerResult.draft,
        number: providerResult.number,
        state: providerResult.state,
        ...(subscribable ? { subscribable } : undefined),
        title: providerResult.title,
        url: providerResult.html_url,
      };
      return {
        objectAnnotations: [
          githubObjectAnnotation({
            ...githubObjectFacts("code_change", {
              ...(parsed as object),
              draft: providerResult.draft,
            }),
            repo: repo.ref,
            number: providerResult.number,
            title: providerResult.title,
            url: providerResult.html_url,
            objectType: "code_change",
            status: providerResult.merged
              ? "merged"
              : providerResult.state === "open" && providerResult.draft
                ? "draft"
                : providerResult.state,
          }),
        ],
        ...(reviewRequested !== undefined
          ? { review_requested: reviewRequested }
          : undefined),
        target: "updatePullRequest",
        ...data,
      };
    },
  });
}
