import { githubObjectAnnotation } from "../annotations.js";
import { readPullRequestCodeOwners } from "../code-owners.js";
import { githubObjectFacts } from "../object-facts.js";
import {
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
import { PULL_REQUEST_CHECKS } from "../graphql-documents.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
  })
  .strict();
const checksSchema = z.object({
  required: z
    .enum(["passing", "failing", "pending", "not_reported"])
    .describe(
      "State of the required checks on the head commit. not_reported means no required check has reported yet; it does not mean that none are required.",
    ),
  failing: z.array(z.string()).describe("Required checks that failed."),
  pending: z
    .array(z.string())
    .describe("Required checks that have not finished."),
  passing: z.array(z.string()).describe("Required checks that passed."),
  incomplete: z
    .literal(true)
    .optional()
    .describe(
      "Set when the head commit has more than 100 checks, so some required checks are not listed.",
    ),
  merge_state: z
    .string()
    .describe(
      "GitHub mergeStateStatus, such as CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, or UNKNOWN. BLOCKED while the listed required checks pass means a required check that has not started, a review, or another rule blocks the merge.",
    ),
  review_decision: z
    .string()
    .nullable()
    .describe(
      "GitHub reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when no review is required.",
    ),
  auto_merge: z
    .boolean()
    .describe("true when auto-merge is on for the pull request."),
});
type Checks = z.output<typeof checksSchema>;
const pullRequestSchema = z.object({
  base: z.string(),
  checks: checksSchema,
  code_owners: z
    .array(z.string())
    .optional()
    .describe(
      "Draft only: the CODEOWNERS owners of the changed files. GitHub asks them to review when the pull request is marked ready for review.",
    ),
  draft: z.boolean(),
  head: z.string(),
  head_sha: commitShaSchema,
  merged: z.boolean(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type PullRequest = z.output<typeof pullRequestSchema>;
interface Result extends PluginToolOutput, PullRequest {
  target: "getPullRequest";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.merge(
  pullRequestSchema.extend({
    target: z.literal("getPullRequest"),
  }),
);
const checkContextSchema = z.union([
  z.object({
    __typename: z.literal("CheckRun"),
    conclusion: z.string().nullable(),
    isRequired: z.boolean(),
    name: z.string(),
    status: z.string(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: z.string(),
    isRequired: z.boolean(),
    state: z.string(),
  }),
]);
const checksResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        autoMergeRequest: z.object({}).passthrough().nullable(),
        commits: z.object({
          nodes: z.array(
            z.object({
              commit: z.object({
                statusCheckRollup: z
                  .object({
                    contexts: z.object({
                      nodes: z.array(checkContextSchema),
                      pageInfo: z.object({ hasNextPage: z.boolean() }),
                    }),
                  })
                  .nullable(),
              }),
            }),
          ),
        }),
        mergeStateStatus: z.string(),
        reviewDecision: z.string().nullable(),
      }),
    }),
  }),
});
type CheckContext = z.output<typeof checkContextSchema>;

// A check run that completed with one of these conclusions does not block a
// merge. Every other conclusion does.
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function contextState(
  context: CheckContext,
): "passing" | "failing" | "pending" {
  if (context.__typename === "CheckRun") {
    if (context.status !== "COMPLETED") return "pending";
    return PASSING_CONCLUSIONS.has(context.conclusion ?? "")
      ? "passing"
      : "failing";
  }
  if (context.state === "SUCCESS") return "passing";
  return context.state === "PENDING" || context.state === "EXPECTED"
    ? "pending"
    : "failing";
}

/** Read the required checks and merge state of one pull request. */
async function readPullRequestChecks(
  egress: PluginEgress,
  repo: { name: string; owner: string },
  number: number,
): Promise<Checks> {
  const response = await githubApi(egress, {
    operation: "github.pull.checks.get",
    method: "POST",
    path: "/graphql",
    body: {
      ...PULL_REQUEST_CHECKS,
      variables: { name: repo.name, number, owner: repo.owner },
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub pull request checks lookup failed with HTTP ${response.status}`,
    );
  }
  const pullRequest = checksResponseSchema.parse(response.body).data.repository
    .pullRequest;
  const rollup = pullRequest.commits.nodes[0]?.commit.statusCheckRollup;
  const checks = { failing: [], pending: [], passing: [] } as Record<
    "failing" | "pending" | "passing",
    string[]
  >;
  for (const context of rollup?.contexts.nodes ?? []) {
    if (!context.isRequired) continue;
    checks[contextState(context)].push(
      context.__typename === "CheckRun" ? context.name : context.context,
    );
  }
  return {
    required:
      checks.failing.length > 0
        ? "failing"
        : checks.pending.length > 0
          ? "pending"
          : checks.passing.length > 0
            ? "passing"
            : "not_reported",
    ...checks,
    ...(rollup?.contexts.pageInfo.hasNextPage
      ? { incomplete: true as const }
      : undefined),
    merge_state: pullRequest.mergeStateStatus,
    review_decision: pullRequest.reviewDecision,
    auto_merge: pullRequest.autoMergeRequest !== null,
  };
}

/** Read one PR and expose its stable subscription identity when webhooks are enabled. */
export function createGitHubGetPullRequestTool(ctx: {
  egress: PluginEgress;
  events: { canSubscribe: boolean };
}) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get a GitHub pull request with its required checks and merge state, and for a draft, the code owners that GitHub asks to review when it is marked ready. Use this when an existing PR may need event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const response = await githubApi(ctx.egress, {
        operation: "github.pull.get",
        path: `${repoPath(repo)}/pulls/${input.number}`,
      });
      if (!response.ok) {
        const message = `GitHub pull request lookup failed with HTTP ${response.status}`;
        // Missing PR/repo is model-repairable. Auth, rate limit, and 5xx stay system errors.
        if (response.status === 404) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const providerResult = z
        .object({
          base: z.object({ ref: z.string() }),
          draft: z.boolean(),
          head: z.object({ ref: z.string(), sha: commitShaSchema }),
          html_url: z.string(),
          merged: z.boolean().optional().default(false),
          number: z.number(),
          state: z.string(),
          title: z.string(),
        })
        .parse(response.body);
      const checks = await readPullRequestChecks(
        ctx.egress,
        repo,
        providerResult.number,
      );
      // Only a draft can still ask its code owners by being marked ready.
      const codeOwners =
        providerResult.draft && providerResult.state === "open"
          ? await readPullRequestCodeOwners(ctx.egress, repo, {
              base: providerResult.base.ref,
              number: providerResult.number,
            })
          : undefined;
      const subscribable = gitHubPullRequestSubscribable({
        canSubscribe: ctx.events.canSubscribe,
        number: providerResult.number,
        repo: repo.ref,
      });
      const data: PullRequest = {
        base: providerResult.base.ref,
        checks,
        ...(codeOwners ? { code_owners: codeOwners } : undefined),
        draft: providerResult.draft,
        head: providerResult.head.ref,
        head_sha: providerResult.head.sha.toLowerCase(),
        merged: providerResult.merged,
        number: providerResult.number,
        state: providerResult.state,
        ...(subscribable ? { subscribable } : undefined),
        title: providerResult.title,
        url: providerResult.html_url,
      };
      return {
        objectAnnotations: [
          githubObjectAnnotation({
            repo: repo.ref,
            number: data.number,
            title: data.title,
            url: data.url,
            objectType: "code_change",
            status: data.merged
              ? "merged"
              : data.state === "open" && data.draft
                ? "draft"
                : data.state,
            ...githubObjectFacts("code_change", response.body),
          }),
        ],
        target: "getPullRequest",
        ...data,
      };
    },
  });
}
