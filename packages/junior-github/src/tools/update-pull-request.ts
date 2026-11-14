import { githubObjectFacts } from "../object-facts.js";
import { githubObjectAnnotation } from "../annotations.js";
import {
  type Identity,
  type User,
  type Actor,
  type PluginLogger,
  type PluginDecider,
  type PluginEgress,
  type Source,
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
  readGitHubBody,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import type { GitHubDb } from "../db/database.js";
import {
  CONVERT_PULL_REQUEST_TO_DRAFT,
  MARK_PULL_REQUEST_READY_FOR_REVIEW,
} from "../graphql-documents.js";
import { recordGitHubPullRequestRequester } from "../pull-request-requesters/store.js";
import { appendGitHubFooter } from "./footer.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";
import { checkPullRequestDescription } from "../tool-support/pull-request-description.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    title: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Replacement pull request title."),
    body: z
      .string()
      .optional()
      .describe(
        "Replacement pull request body. The runtime appends requester attribution and the conversation footer.",
      ),
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
  })
  .strict()
  .refine(
    ({ title, body, base, state, draft }) =>
      title !== undefined ||
      body !== undefined ||
      base !== undefined ||
      state !== undefined ||
      draft !== undefined,
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
  target: "updatePullRequest";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.merge(
  pullRequestSchema.extend({
    target: z.literal("updatePullRequest"),
  }),
);

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(`${name} is required`);
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

/** Update mutable PR metadata while preserving runtime-owned body attribution. */
export function createGitHubUpdatePullRequestTool(
  /** Set when the description check experiment is on. */
  descriptionChecks = false,
) {
  return definePluginTool({
    permission: "review",
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
        actor?: Actor;
        automationLink?: { url: string };
        conversationId?: string;
        db: unknown;
        decider: PluginDecider;
        egress: PluginEgress;
        log: PluginLogger;
        events: { canSubscribe: boolean };
        conversationLink?: { url: string };
        source?: Source;
        users: {
          resolveActor(): Promise<
            { identity?: Identity; user?: User } | undefined
          >;
        };
      },
    ): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub updatePullRequest input.",
          { cause: parsedInput.error },
        );
      }
      const update = parsedInput.data;
      if (descriptionChecks && update.body !== undefined) {
        await checkPullRequestDescription(ctx.decider, update.body);
      }
      const repo = parseRepo(update.repo);
      const requester = await resolveGitHubRequester(ctx);
      const currentBody =
        update.body !== undefined
          ? await readGitHubBody(ctx.egress, {
              operation: "github.pull.get",
              path: `${repoPath(repo)}/pulls/${update.number}`,
            })
          : undefined;
      const payload = {
        ...(update.title !== undefined ? { title: update.title } : undefined),
        ...(update.body !== undefined
          ? {
              body: appendGitHubFooter(
                appendGitHubRequesterAttribution(
                  update.body,
                  ctx,
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
        path: `${repoPath(repo)}/pulls/${update.number}`,
        ...(hasRestUpdate ? { method: "PATCH", body: payload } : undefined),
      });
      const parsed = response.body;
      if (!response.ok) {
        const message = `GitHub pull request update failed with HTTP ${response.status}: ${githubErrorMessage(parsed)}`;
        // 404 and 422 mean the model named a missing pull request or GitHub
        // rejected the requested change, such as a base change in a stack.
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
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
      if (requester?.identity) {
        await recordGitHubPullRequestRequester(ctx.db as GitHubDb, {
          identityId: requester.identity.id,
          number: providerResult.number,
          repositoryFullName: repo.ref,
        });
      }
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
        target: "updatePullRequest",
        ...data,
      };
    },
  });
}
