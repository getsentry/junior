import { githubObjectFacts } from "../object-facts.js";
import { githubObjectAnnotation } from "../annotations.js";
import {
  type Identity,
  type User,
  type Actor,
  type PluginLogger,
  type PluginEgress,
  type Source,
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
  appendGitHubRequesterAttribution,
  linkedGitHubLogin,
  readGitHubBody,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import { appendGitHubFooter } from "./footer.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
  repoPath,
} from "../tool-support/github-api.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Issue number."),
    title: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Replacement issue title."),
    body: z
      .string()
      .optional()
      .describe(
        "Replacement issue body. The runtime appends requester attribution and the conversation footer.",
      ),
    state: z
      .enum(["open", "closed"])
      .optional()
      .describe("Replacement issue state."),
    assign_requester: z
      .boolean()
      .optional()
      .describe(
        "Set true to add the requester's linked GitHub account as an assignee. Other assignees stay.",
      ),
  })
  .strict()
  .refine(
    ({ title, body, state, assign_requester }) =>
      title !== undefined ||
      body !== undefined ||
      state !== undefined ||
      assign_requester === true,
    { message: "At least one issue field must be provided." },
  );

const issueSchema = z.object({
  assignees: z.array(z.string()),
  body: z.string().nullable(),
  number: z.number(),
  state: z.string(),
  subscribable: subscribableResourceSchema.optional(),
  title: z.string(),
  url: z.string(),
});
type Issue = z.output<typeof issueSchema>;
interface Result extends PluginToolOutput, Issue {
  target: "updateIssue";
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolOutputSchema.merge(
  issueSchema.extend({
    target: z.literal("updateIssue"),
  }),
);

const providerIssueSchema = z.object({
  assignees: z
    .array(z.object({ login: z.string() }))
    .nullish()
    .transform((assignees) => assignees?.map(({ login }) => login) ?? []),
  body: z.string().nullable().optional().default(null),
  html_url: z.string(),
  number: z.number(),
  state: z.string(),
  title: z.string(),
});

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new PluginToolInputError(`${name} is required`);
  return value.trim();
}

/** Update mutable issue metadata while preserving runtime-owned body attribution. */
export const gitHubUpdateIssueTool = definePluginTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Update an existing GitHub issue's title, body, or open/closed state, or assign it to the requester. Use this instead of raw GitHub API calls when changing issue metadata.",
  inputSchema,
  outputSchema,
  async execute(
    input,
    _options,
    ctx: {
      actor?: Actor | undefined;
      automationLink?: { url: string };
      conversationId?: string | undefined;
      egress: PluginEgress;
      log: PluginLogger;
      events: { canSubscribe: boolean };
      conversationLink?: { url: string };
      source?: Source | undefined;
      users: {
        resolveActor(): Promise<
          { identity?: Identity; user?: User } | undefined
        >;
      };
    },
  ): Promise<Result> {
    const parsedInput = inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new PluginToolInputError("Invalid GitHub updateIssue input.", {
        cause: parsedInput.error,
      });
    }
    const update = parsedInput.data;
    const repo = parseRepo(update.repo);
    const requester =
      update.body !== undefined || update.assign_requester
        ? await resolveGitHubRequester(ctx)
        : undefined;
    // Check before any write, so a failed assignment changes nothing.
    const assignee = update.assign_requester
      ? linkedGitHubLogin(requester?.user)
      : undefined;
    if (update.assign_requester && !assignee) {
      throw new PluginToolInputError(
        "The requester has no linked GitHub account, so Junior cannot assign the issue to them.",
      );
    }
    const currentBody =
      update.body !== undefined
        ? await readGitHubBody(ctx.egress, {
            operation: "github.issue.get",
            path: `${repoPath(repo)}/issues/${update.number}`,
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
      ...(update.state !== undefined ? { state: update.state } : undefined),
    };
    let parsed: unknown;
    if (Object.keys(payload).length > 0) {
      const response = await githubApi(ctx.egress, {
        operation: "github.issue.update",
        method: "PATCH",
        path: `${repoPath(repo)}/issues/${update.number}`,
        body: payload,
      });
      parsed = response.body;
      if (!response.ok) {
        throw new Error(
          `GitHub issue update failed with HTTP ${response.status}: ${githubErrorMessage(parsed)}`,
        );
      }
    }
    if (assignee) {
      // This endpoint adds assignees. A PATCH with `assignees` replaces them.
      const response = await githubApi(ctx.egress, {
        operation: "github.issue.assign",
        method: "POST",
        path: `${repoPath(repo)}/issues/${update.number}/assignees`,
        body: { assignees: [assignee] },
      });
      parsed = response.body;
      if (!response.ok) {
        const message = `GitHub issue assignment failed with HTTP ${response.status}: ${githubErrorMessage(parsed)}`;
        // A missing issue or an invalid assignee is a wrong target.
        if (response.status === 404 || response.status === 422) {
          throw new PluginToolInputError(message);
        }
        throw new Error(message);
      }
    }
    const providerResult = providerIssueSchema.parse(parsed);
    // GitHub ignores an assignee who cannot be assigned in the repo. Logins
    // are case-insensitive.
    if (
      assignee &&
      !providerResult.assignees.some(
        (login) => login.toLowerCase() === assignee.toLowerCase(),
      )
    ) {
      throw new PluginToolInputError(
        `GitHub did not assign @${assignee} to the issue. They may not have access to ${repo.ref}.`,
      );
    }
    const subscribable = gitHubIssueSubscribable({
      canSubscribe: ctx.events.canSubscribe,
      number: providerResult.number,
      repo: repo.ref,
    });
    return {
      objectAnnotations: [
        githubObjectAnnotation({
          ...githubObjectFacts("task", parsed),
          repo: repo.ref,
          number: providerResult.number,
          title: providerResult.title,
          url: providerResult.html_url,
          objectType: "task",
          status: providerResult.state,
        }),
      ],
      target: "updateIssue",
      assignees: providerResult.assignees,
      body: providerResult.body,
      number: providerResult.number,
      state: providerResult.state,
      ...(subscribable ? { subscribable } : undefined),
      title: providerResult.title,
      url: providerResult.html_url,
    };
  },
});
