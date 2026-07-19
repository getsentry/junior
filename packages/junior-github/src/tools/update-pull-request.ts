import {
  definePluginTool,
  PluginToolInputError,
  pluginToolResultSchema,
  type PluginToolResult,
  type SubscribableResource,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { subscribableResourceSchema } from "@sentry/junior-plugin-api";
import { gitHubPullRequestSubscribable } from "../resource-events/pull-request.js";
import { appendGitHubRequesterAttribution } from "../tool-support/attribution.js";
import { appendGitHubFooter } from "./footer.js";

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
        "Replacement pull request body. Junior appends requester attribution and the conversation footer.",
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
  })
  .strict()
  .refine(
    ({ title, body, base, state }) =>
      title !== undefined ||
      body !== undefined ||
      base !== undefined ||
      state !== undefined,
    { message: "At least one pull request field must be provided." },
  );

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
interface Result extends PluginToolResult, PullRequest {
  ok: true;
  status: "success";
  target: "updatePullRequest";
  data: PullRequest;
  subscribable?: SubscribableResource;
}
const outputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.literal("updatePullRequest"),
  data: pullRequestSchema,
  ...pullRequestSchema.shape,
});

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(`${name} is required`);
  }
  return value.trim();
}

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubApiErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return "GitHub request failed";
}

/** Update mutable PR metadata while preserving Junior-owned body attribution. */
export function createGitHubUpdatePullRequestTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    description:
      "Update an existing GitHub pull request's title, body, base branch, or open/closed state. Use this instead of raw GitHub API calls when changing PR metadata.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub updatePullRequest input.",
          { cause: parsedInput.error },
        );
      }
      const update = parsedInput.data;
      const repo = parseRepo(update.repo);
      const payload = {
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.body !== undefined
          ? {
              body: appendGitHubFooter(
                appendGitHubRequesterAttribution(update.body, ctx.actor),
                nonEmptyString(ctx.conversationId, "conversationId"),
                ctx.slack?.conversationLink?.url,
              ),
            }
          : {}),
        ...(update.base !== undefined ? { base: update.base } : {}),
        ...(update.state !== undefined ? { state: update.state } : {}),
      };
      const response = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.update",
        request: new Request(
          `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${update.number}`,
          {
            method: "PATCH",
            headers: {
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(payload),
          },
        ),
      });
      const parsed = await readJson(response);
      if (!response.ok) {
        throw new Error(
          `GitHub pull request update failed with HTTP ${response.status}: ${githubApiErrorMessage(parsed)}`,
        );
      }
      const providerResult = z
        .object({
          base: z.object({ ref: z.string() }),
          body: z.string().nullable().optional().default(null),
          draft: z.boolean(),
          html_url: z.string(),
          number: z.number(),
          state: z.string(),
          title: z.string(),
        })
        .parse(parsed);
      const subscribable = gitHubPullRequestSubscribable({
        number: providerResult.number,
        repo: repo.ref,
      });
      const data: PullRequest = {
        base: providerResult.base.ref,
        body: providerResult.body,
        draft: providerResult.draft,
        number: providerResult.number,
        state: providerResult.state,
        ...(subscribable ? { subscribable } : {}),
        title: providerResult.title,
        url: providerResult.html_url,
      };
      return {
        ok: true,
        status: "success",
        target: "updatePullRequest",
        data,
        ...data,
      };
    },
  });
}
