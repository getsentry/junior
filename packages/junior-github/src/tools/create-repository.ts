import {
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolExecuteOptions,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX } from "../egress-policy.js";
import { githubApi, githubErrorMessage } from "../tool-support/github-api.js";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60_000;
// GitHub owner logins and repository names. A name cannot be "." or "..".
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

const inputSchema = z
  .object({
    owner: z
      .string()
      .regex(OWNER_PATTERN, "owner must be a GitHub organization login")
      .describe(
        "GitHub organization that owns the new repository. It must be the organization where the GitHub App is installed. Personal accounts are not supported.",
      ),
    name: z
      .string()
      .regex(
        NAME_PATTERN,
        "name may use only letters, digits, '.', '-', and '_'",
      )
      .describe("Name of the new repository."),
    description: z
      .string()
      .max(350)
      .describe("Short description of the repository.")
      .optional(),
    visibility: z
      .enum(["private", "public"])
      .describe("Visibility of the new repository. Defaults to private.")
      .optional(),
    auto_init: z
      .boolean()
      .describe(
        "Create an initial commit with an empty README. Defaults to true, so that the repository has a default branch for pull requests.",
      )
      .optional(),
  })
  .strict();
type Input = z.output<typeof inputSchema>;

const repositorySchema = z.object({
  default_branch: z.string().nullable(),
  full_name: z.string(),
  private: z.boolean(),
  url: z.string(),
});
type Repository = z.output<typeof repositorySchema>;

const outputSchema = pluginToolOutputSchema.merge(
  repositorySchema.extend({ target: z.literal("createRepository") }),
);

/**
 * Durable idempotency record. `pending` blocks a retry whose first request
 * may have created the repository; `completed` replays the result.
 */
const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({ status: z.literal("completed"), repository: repositorySchema })
    .strict(),
]);

const providerRepositorySchema = z.object({
  default_branch: z.string().nullable().optional(),
  full_name: z.string(),
  html_url: z.string(),
  private: z.boolean(),
});

function visibility(input: Input): "private" | "public" {
  return input.visibility ?? "private";
}

function isEgressAuthRequired(error: unknown): boolean {
  return (
    error instanceof EgressAuthRequired ||
    (error instanceof Error && error.name === "EgressAuthRequired")
  );
}

/** Send the create request. An authorization pause creates nothing. */
async function sendCreate(
  ctx: ToolRegistrationHookContext,
  input: Input,
  key: string,
) {
  try {
    return await githubApi(ctx.egress, {
      operation: `${GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX}${input.owner}/${input.name}`,
      method: "POST",
      path: `/orgs/${encodeURIComponent(input.owner)}/repos`,
      body: {
        name: input.name,
        ...(input.description ? { description: input.description } : undefined),
        visibility: visibility(input),
        auto_init: input.auto_init ?? true,
      },
    });
  } catch (error) {
    if (isEgressAuthRequired(error)) await ctx.state.delete(key);
    throw error;
  }
}

/** Create a GitHub organization repository with the GitHub App. */
export function createGitHubCreateRepositoryTool(
  ctx: ToolRegistrationHookContext,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal: (input) =>
      `Create ${visibility(input)} GitHub repository ${input.owner}/${input.name}`,
    description:
      "Create a new GitHub repository in an organization where the GitHub App is installed. Use this instead of gh repo create.",
    exposure: "direct",
    inputSchema,
    outputSchema,
    async execute(input, options: PluginToolExecuteOptions) {
      const conversationId = ctx.conversationId;
      const toolCallId = options.toolCallId;
      if (!conversationId || !toolCallId) {
        throw new Error(
          "GitHub repository creation needs a conversation and a tool call id.",
        );
      }
      const key = `createRepository:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(`${key}:lock`, LOCK_TTL_MS, async () => {
        const stored = await ctx.state.get(key);
        const state =
          stored === undefined ? undefined : stateSchema.parse(stored);
        if (state?.status === "completed") {
          return { target: "createRepository" as const, ...state.repository };
        }
        if (state?.status === "pending") {
          throw new Error(
            "GitHub repository creation for this tool call has an uncertain result; refusing to create it again. Check whether the repository exists.",
          );
        }
        await ctx.state.set(key, { status: "pending" }, IDEMPOTENCY_TTL_MS);
        const response = await sendCreate(ctx, input, key);
        if (!response.ok) {
          const message = `GitHub repository creation failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
          // A 4xx refused the create, so a retry cannot duplicate it. It
          // names the cause, such as an organization without the App or a
          // taken name. A 5xx may still have created it, so pending stays.
          if (response.status < 500) {
            await ctx.state.delete(key);
            throw new PluginToolInputError(message);
          }
          throw new Error(message);
        }
        const created = providerRepositorySchema.parse(response.body);
        const repository: Repository = {
          default_branch: created.default_branch ?? null,
          full_name: created.full_name,
          private: created.private,
          url: created.html_url,
        };
        await ctx.state.set(
          key,
          { status: "completed", repository },
          IDEMPOTENCY_TTL_MS,
        );
        return { target: "createRepository" as const, ...repository };
      });
    },
  });
}
