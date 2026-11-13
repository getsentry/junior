import {
  type PluginEgress,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
  pluginToolDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  RESOLVE_REVIEW_THREAD,
  REVIEW_THREAD_OWNERSHIP,
} from "../graphql-documents.js";
import { botUserIdFromEmail } from "../webhooks/ownership.js";
import {
  githubApi,
  githubErrorMessage,
  parseRepo,
} from "../tool-support/github-api.js";

/**
 * GraphQL-only GitHub mutation. There is no REST endpoint and no first-class
 * `gh pr` subcommand yet, so this tool is the runtime substitute for:
 *
 * ```
 * gh api graphql \
 *   -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}' \
 *   -F id=THREAD_ID
 * ```
 *
 * `repo` is required so the runtime can bind the GraphQL operation to a repository;
 * GraphQL has no repo path to derive that from.
 */
const inputSchema = z
  .object({
    repo: z
      .string()
      .describe(
        'Repository in "owner/name" format. Required because GraphQL has no repo path.',
      ),
    thread_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        "GitHub pull request review thread node ID (the `threadId` / `id` variable used by `gh api graphql` resolveReviewThread).",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("resolvePullRequestReviewThread"),
  repo: z.string(),
  number: z.number(),
  thread_id: z.string(),
  resolved: z.boolean(),
});
interface Result extends PluginToolOutput {
  target: "resolvePullRequestReviewThread";
  repo: string;
  number: number;
  thread_id: string;
  resolved: boolean;
}

export const gitHubResolvePullRequestReviewThreadToolDefinition =
  pluginToolDefinition({
    // No action review: the tool checks in code that the bot authored the pull
    // request, and it changes only the thread's resolved state, which is
    // reversible.
    approvalMode: "approve",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Resolve a GitHub pull request review thread after acting on its feedback. Only works on pull requests the bot authored.",
    exposure: "direct",
    inputSchema,
    outputSchema,
  });

/** Resolve one review thread after GitHub proves it belongs to a bot-authored PR. */
export function createGitHubResolvePullRequestReviewThreadTool(
  ctx: { egress: PluginEgress },
  botEmail: string | undefined,
) {
  return definePluginTool({
    ...gitHubResolvePullRequestReviewThreadToolDefinition,
    async execute(input): Promise<Result> {
      const parsedInput = inputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new PluginToolInputError(
          "Invalid GitHub resolvePullRequestReviewThread input.",
          { cause: parsedInput.error },
        );
      }
      const repo = parseRepo(parsedInput.data.repo);
      const botUserId = botUserIdFromEmail(botEmail);
      if (botUserId === undefined) {
        throw new Error("GitHub App bot identity is not configured.");
      }

      const lookupResponse = await githubApi(ctx.egress, {
        operation: "github.pull.review-thread.get",
        method: "POST",
        path: "/graphql",
        body: {
          ...REVIEW_THREAD_OWNERSHIP,
          variables: { threadId: parsedInput.data.thread_id },
        },
      });
      const lookupPayload = lookupResponse.body;
      if (!lookupResponse.ok) {
        throw new Error(
          `GitHub review thread lookup failed with HTTP ${lookupResponse.status}: ${githubErrorMessage(lookupPayload)}`,
        );
      }
      // GitHub's GraphQL shape is out of Junior's control and can add fields
      // or resolve `node` to an unexpected type; use `passthrough()` so new
      // fields don't break parsing, and `safeParse()` so a shape mismatch
      // (missing thread, wrong node type) becomes the same clean
      // "not found" error as an explicit `node: null`, instead of an
      // unhandled ZodError.
      const threadNodeSchema = z
        .object({
          id: z.string(),
          isResolved: z.boolean(),
          pullRequest: z
            .object({
              author: z
                .object({ databaseId: z.number().optional() })
                .passthrough()
                .nullable(),
              number: z.number(),
              repository: z.object({ nameWithOwner: z.string() }).passthrough(),
            })
            .passthrough(),
        })
        .passthrough();
      const lookupResultSchema = z
        .object({
          data: z
            .object({
              node: z.unknown().nullable().optional(),
            })
            .passthrough(),
        })
        .passthrough();
      const lookupResult = lookupResultSchema.safeParse(lookupPayload);
      const rawNode = lookupResult.success
        ? lookupResult.data.data.node
        : undefined;
      const parsedNode =
        rawNode == null ? undefined : threadNodeSchema.safeParse(rawNode);
      if (!parsedNode?.success) {
        throw new PluginToolInputError("GitHub review thread was not found.");
      }
      const thread = parsedNode.data;

      const pullRequest = thread.pullRequest;
      const ownsPullRequest =
        pullRequest.repository.nameWithOwner.toLowerCase() ===
          repo.ref.toLowerCase() &&
        pullRequest.author?.databaseId === botUserId;
      if (!ownsPullRequest) {
        throw new PluginToolInputError(
          "This bot can only resolve review threads on pull requests it authored.",
        );
      }
      if (thread.isResolved) {
        return {
          target: "resolvePullRequestReviewThread",
          repo: repo.ref,
          number: pullRequest.number,
          thread_id: thread.id,
          resolved: true,
        };
      }

      const resolveResponse = await githubApi(ctx.egress, {
        operation: `github.pull.review-thread.resolve:${repo.ref.toLowerCase()}`,
        method: "POST",
        path: "/graphql",
        body: {
          ...RESOLVE_REVIEW_THREAD,
          variables: { threadId: thread.id },
        },
      });
      const resolvePayload = resolveResponse.body;
      if (!resolveResponse.ok) {
        throw new Error(
          `GitHub review thread resolution failed with HTTP ${resolveResponse.status}: ${githubErrorMessage(resolvePayload)}`,
        );
      }
      const resolveResultSchema = z
        .object({
          data: z
            .object({
              resolveReviewThread: z
                .object({
                  thread: z
                    .object({ id: z.string(), isResolved: z.boolean() })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough();
      const resolveResult = resolveResultSchema.safeParse(resolvePayload);
      if (!resolveResult.success) {
        // At this point the thread was found and ownership-verified, and
        // the resolve mutation was already sent, so this is not a "not
        // found" case: the mutation may have succeeded despite the
        // unexpected response shape.
        throw new Error(
          "GitHub review thread resolution returned an unexpected response shape.",
          { cause: resolveResult.error },
        );
      }
      const resolved = resolveResult.data.data.resolveReviewThread.thread;
      if (resolved.id !== thread.id || !resolved.isResolved) {
        throw new Error("GitHub did not resolve the requested review thread.");
      }
      return {
        target: "resolvePullRequestReviewThread",
        repo: repo.ref,
        number: pullRequest.number,
        thread_id: resolved.id,
        resolved: true,
      };
    },
  });
}
