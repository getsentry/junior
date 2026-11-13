import { githubObjectAnnotation } from "../annotations.js";
import { githubObjectFacts } from "../object-facts.js";
import {
  type Actor,
  type Identity,
  type PluginEgress,
  type PluginLogger,
  type User,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubIssueSubscribable } from "../events/issue.js";
import {
  linkedGitHubLogin,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

// Only reads of an issue the requester does not own get this note, so the
// claim step appears when it can still change something.
const CLAIM_NOTE =
  "If you start work on this issue, first claim it with github_updateIssue and assign_requester: true.";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Issue number."),
  })
  .strict();
const issueSchema = z.object({
  assignees: z.array(z.string()),
  author: z.string().optional(),
  body: z.string().nullable(),
  comments: z.number(),
  labels: z.array(z.string()),
  note: z.string().optional(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type Issue = z.output<typeof issueSchema>;
interface Result extends PluginToolOutput, Issue {
  target: "getIssue";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.merge(
  issueSchema.extend({ target: z.literal("getIssue") }),
);
const providerIssueSchema = z.object({
  assignees: z
    .array(z.object({ login: z.string() }))
    .nullish()
    .transform((assignees) => assignees?.map(({ login }) => login) ?? []),
  body: z.string().nullable().optional().default(null),
  comments: z.number().optional().default(0),
  html_url: z.string(),
  labels: z
    .array(z.object({ name: z.string() }))
    .optional()
    .default([])
    .transform((labels) => labels.map(({ name }) => name)),
  number: z.number(),
  repository_url: z.string().optional(),
  state: z.string(),
  title: z.string(),
  user: z.object({ login: z.string() }).nullish(),
});

/**
 * Read one GitHub issue. Sandbox issue reads are routed here so the result can
 * tell the agent to claim an issue that the requester does not own yet.
 */
export function createGitHubGetIssueTool(ctx: {
  actor?: Actor;
  egress: PluginEgress;
  events: { canSubscribe: boolean };
  log: PluginLogger;
  users: {
    resolveActor(): Promise<{ identity?: Identity; user?: User } | undefined>;
  };
}) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get a GitHub issue. Read its comments with gh api repos/OWNER/REPO/issues/NUMBER/comments.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const [response, requester] = await Promise.all([
        githubApi(ctx.egress, {
          followRedirects: true,
          operation: "github.issue.get",
          path: `${repoPath(repo)}/issues/${input.number}`,
        }),
        resolveGitHubRequester(ctx),
      ]);
      if (!response.ok) {
        const message = `GitHub issue lookup failed with HTTP ${response.status}`;
        // Missing issue/repo is model-repairable. Auth, rate limit, and 5xx stay system errors.
        if (response.status === 404) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
      const issue = providerIssueSchema.parse(response.body);
      // A transferred issue redirects to its new repository.
      const repoRef = issueRepoRef(issue.repository_url) ?? repo.ref;
      const login = linkedGitHubLogin(requester?.user)?.toLowerCase();
      const needsClaim =
        login !== undefined &&
        issue.state === "open" &&
        !issue.assignees.some((assignee) => assignee.toLowerCase() === login);
      const subscribable = gitHubIssueSubscribable({
        canSubscribe: ctx.events.canSubscribe,
        number: issue.number,
        repo: repoRef,
      });
      return {
        objectAnnotations: [
          githubObjectAnnotation({
            ...githubObjectFacts("task", response.body),
            repo: repoRef,
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            objectType: "task",
            status: issue.state,
          }),
        ],
        target: "getIssue",
        assignees: issue.assignees,
        ...(issue.user ? { author: issue.user.login } : undefined),
        body: issue.body,
        comments: issue.comments,
        labels: issue.labels,
        ...(needsClaim ? { note: CLAIM_NOTE } : undefined),
        number: issue.number,
        state: issue.state,
        ...(subscribable ? { subscribable } : undefined),
        title: issue.title,
        url: issue.html_url,
      };
    },
  });
}

function issueRepoRef(repositoryUrl: string | undefined): string | undefined {
  const url = repositoryUrl ? URL.parse(repositoryUrl) : null;
  if (url?.origin !== "https://api.github.com" || url.search || url.hash) {
    return undefined;
  }
  const [repos, owner, repo, ...rest] = url.pathname.slice(1).split("/");
  return repos === "repos" && owner && repo && rest.length === 0
    ? `${owner}/${repo}`
    : undefined;
}
