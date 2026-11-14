import { githubObjectAnnotation } from "../annotations.js";
import { readDraftReadiness } from "../draft-readiness.js";
import { githubObjectFacts } from "../object-facts.js";
import {
  type PluginConversationToolContext,
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
const RELATED_CONVERSATIONS_MAX = 10;
const SUMMARY_MAX_LENGTH = 300;
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
const relatedConversationSchema = z.object({
  conversation_id: z.string(),
  root_conversation_id: z
    .string()
    .optional()
    .describe("Root of a child agent."),
  status: z
    .enum(["pending", "running", "paused", "idle"])
    .describe(
      "What its agent does now. pending: waiting to run. running or paused: working. idle: waits for a message.",
    ),
  title: z.string().optional(),
  summary: z.string().optional().describe("Summary from the latest Brief."),
  updated_at: z.string().describe("Time of the latest activity."),
});
type RelatedConversation = z.output<typeof relatedConversationSchema>;
const pullRequestSchema = z.object({
  base: z.string(),
  agents_md: z
    .string()
    .optional()
    .describe(
      "Draft only: the root AGENTS.md of the base branch, when it has one.",
    ),
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
  related_conversations: z
    .array(relatedConversationSchema)
    .optional()
    .describe(
      "Other conversations that touched this pull request, working ones first. While one is working, do not push to or comment on the pull request; first messageAgent its root (root_conversation_id, else conversation_id).",
    ),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type PullRequest = z.output<typeof pullRequestSchema>;
interface Result extends PluginToolOutput, PullRequest {
  target: "getPullRequest";
  subscribable?: SubscribableResource | undefined;
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

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Other Conversations that touched one pull request: working ones first,
 * then newest activity.
 */
async function readRelatedConversations(
  conversations: PluginConversationToolContext | undefined,
  annotation: string,
): Promise<RelatedConversation[]> {
  if (!conversations) return [];
  const matches = await conversations.search({
    annotation,
    limit: RELATED_CONVERSATIONS_MAX,
  });
  return matches.map((match) => ({
    conversation_id: match.conversationId,
    ...(match.rootConversationId
      ? { root_conversation_id: match.rootConversationId }
      : undefined),
    status: match.status,
    ...(match.title ? { title: match.title } : undefined),
    ...(match.summary
      ? { summary: truncate(match.summary, SUMMARY_MAX_LENGTH) }
      : undefined),
    updated_at: match.updatedAt,
  }));
}

/** Read one PR and expose its stable subscription identity when webhooks are enabled. */
export const gitHubGetPullRequestTool = definePluginTool({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Get a GitHub pull request with its required checks, merge state, and other conversations that touched it, and for a draft, what to check before marking it ready. Use this when an existing PR may need event monitoring; the result includes a subscribable hint when GitHub webhooks are configured.",
  inputSchema,
  outputSchema,
  async execute(
    input,
    _options,
    ctx: {
      conversations?: PluginConversationToolContext;
      egress: PluginEgress;
      events: { canSubscribe: boolean };
    },
  ): Promise<Result> {
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
    const annotation = githubObjectAnnotation({
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
      ...githubObjectFacts("code_change", response.body),
    });
    const [checks, relatedConversations] = await Promise.all([
      readPullRequestChecks(ctx.egress, repo, providerResult.number),
      readRelatedConversations(ctx.conversations, annotation.key),
    ]);
    // Only a draft can still ask its code owners by being marked ready.
    const readiness =
      providerResult.draft && providerResult.state === "open"
        ? await readDraftReadiness(ctx.egress, repo, {
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
      ...(readiness?.agentsMd ? { agents_md: readiness.agentsMd } : undefined),
      checks,
      ...(readiness ? { code_owners: readiness.codeOwners } : undefined),
      draft: providerResult.draft,
      head: providerResult.head.ref,
      head_sha: providerResult.head.sha.toLowerCase(),
      merged: providerResult.merged,
      number: providerResult.number,
      ...(relatedConversations.length > 0
        ? { related_conversations: relatedConversations }
        : undefined),
      state: providerResult.state,
      ...(subscribable ? { subscribable } : undefined),
      title: providerResult.title,
      url: providerResult.html_url,
    };
    return {
      objectAnnotations: [annotation],
      target: "getPullRequest",
      ...data,
    };
  },
});
