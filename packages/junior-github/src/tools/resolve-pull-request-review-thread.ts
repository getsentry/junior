import {
  type PluginEgress,
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { botUserIdFromEmail } from "../webhooks/ownership.js";

/**
 * GraphQL-only GitHub mutation. There is no REST endpoint and no first-class
 * `gh pr` subcommand yet, so this tool is the Junior substitute for:
 *
 * ```
 * gh api graphql \
 *   -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}' \
 *   -F id=THREAD_ID
 * ```
 *
 * `repo` is required so Junior can bind the GraphQL operation to a repository
 * credential; GraphQL has no repo path to derive that from.
 */
const inputSchema = z
  .object({
    repo: z
      .string()
      .describe(
        'Repository in "owner/name" format. Required because GraphQL has no repo path.',
      ),
    threadId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "GitHub pull request review thread node ID (the same `threadId` / `id` variable used by `gh api graphql` resolveReviewThread).",
      ),
  })
  .strict();

const outputSchema = pluginToolOutputSchema.extend({
  target: z.literal("resolvePullRequestReviewThread"),
  repo: z.string(),
  number: z.number(),
  threadId: z.string(),
  resolved: z.boolean(),
});
interface Result extends PluginToolOutput {
  target: "resolvePullRequestReviewThread";
  repo: string;
  number: number;
  threadId: string;
  resolved: boolean;
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

function githubError(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "GitHub request failed";
}

/** Resolve one review thread after GitHub proves it belongs to a Junior-authored PR. */
export function createGitHubResolvePullRequestReviewThreadTool(
  ctx: { egress: PluginEgress },
  botEmail: string | undefined,
) {
  return definePluginTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Resolve a GitHub pull request review thread. Use this instead of shelling out to `gh api graphql` for resolveReviewThread (GraphQL-only; no REST or `gh pr` equivalent). Only works on pull requests Junior authored.",
    inputSchema,
    outputSchema,
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

      const query = `query ReviewThreadOwnership($threadId: ID!) {
        node(id: $threadId) {
          ... on PullRequestReviewThread {
            id
            isResolved
            pullRequest {
              number
              repository { nameWithOwner }
              author { ... on Bot { databaseId } }
            }
          }
        }
      }`;
      const lookupResponse = await ctx.egress.fetch({
        provider: "github",
        operation: "github.pull.review-thread.get",
        request: new Request("https://api.github.com/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationName: "ReviewThreadOwnership",
            query,
            variables: { threadId: parsedInput.data.threadId },
          }),
        }),
      });
      const lookupPayload = await readJson(lookupResponse);
      if (!lookupResponse.ok) {
        throw new Error(
          `GitHub review thread lookup failed with HTTP ${lookupResponse.status}: ${githubError(lookupPayload)}`,
        );
      }
      const thread = z
        .object({
          data: z.object({
            node: z
              .object({
                id: z.string(),
                isResolved: z.boolean(),
                pullRequest: z.object({
                  author: z
                    .object({ databaseId: z.number().optional() })
                    .nullable(),
                  number: z.number(),
                  repository: z.object({ nameWithOwner: z.string() }),
                }),
              })
              .nullable(),
          }),
        })
        .parse(lookupPayload).data.node;
      if (!thread) {
        throw new PluginToolInputError("GitHub review thread was not found.");
      }

      const pullRequest = thread.pullRequest;
      const ownsPullRequest =
        pullRequest.repository.nameWithOwner.toLowerCase() ===
          repo.ref.toLowerCase() &&
        pullRequest.author?.databaseId === botUserId;
      if (!ownsPullRequest) {
        throw new PluginToolInputError(
          "Junior can only resolve review threads on pull requests it authored.",
        );
      }
      if (thread.isResolved) {
        return {
          target: "resolvePullRequestReviewThread",
          repo: repo.ref,
          number: pullRequest.number,
          threadId: thread.id,
          resolved: true,
        };
      }

      // Same mutation shape as `gh api graphql` resolveReviewThread.
      const mutation = `mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: {threadId: $threadId}) {
          thread { id isResolved }
        }
      }`;
      const resolveResponse = await ctx.egress.fetch({
        provider: "github",
        operation: `github.pull.review-thread.resolve:${repo.ref.toLowerCase()}`,
        request: new Request("https://api.github.com/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationName: "ResolveReviewThread",
            query: mutation,
            variables: { threadId: thread.id },
          }),
        }),
      });
      const resolvePayload = await readJson(resolveResponse);
      if (!resolveResponse.ok) {
        throw new Error(
          `GitHub review thread resolution failed with HTTP ${resolveResponse.status}: ${githubError(resolvePayload)}`,
        );
      }
      const resolved = z
        .object({
          data: z.object({
            resolveReviewThread: z.object({
              thread: z.object({ id: z.string(), isResolved: z.boolean() }),
            }),
          }),
        })
        .parse(resolvePayload).data.resolveReviewThread.thread;
      if (resolved.id !== thread.id || !resolved.isResolved) {
        throw new Error("GitHub did not resolve the requested review thread.");
      }
      return {
        target: "resolvePullRequestReviewThread",
        repo: repo.ref,
        number: pullRequest.number,
        threadId: resolved.id,
        resolved: true,
      };
    },
  });
}
