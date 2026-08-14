import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolOutput,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { GITHUB_SESSION_FOOTER_START } from "./footer.js";
import { botLoginFromEmail } from "../webhooks/ownership.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    number: z.number().int().positive().describe("Pull request number."),
    threadId: z.string().trim().min(1).describe("GitHub review thread node ID."),
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
  ctx: ToolRegistrationHookContext,
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
      "Resolve a GitHub pull request review thread. This only works when Junior authored the pull request.",
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
      const botLogin = botLoginFromEmail(botEmail)?.toLowerCase();
      if (!botLogin) {
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
              author { login }
              body
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
                  author: z.object({ login: z.string() }),
                  body: z.string().nullable(),
                  number: z.number(),
                  repository: z.object({ nameWithOwner: z.string() }),
                }),
              })
              .nullable(),
          }),
        })
        .parse(lookupPayload).data.node;
      if (!thread) throw new Error("GitHub review thread was not found.");

      const pullRequest = thread.pullRequest;
      const ownsPullRequest =
        pullRequest.number === parsedInput.data.number &&
        pullRequest.repository.nameWithOwner.toLowerCase() ===
          repo.ref.toLowerCase() &&
        pullRequest.author.login.toLowerCase() === botLogin &&
        pullRequest.body?.includes(GITHUB_SESSION_FOOTER_START);
      if (!ownsPullRequest) {
        throw new Error(
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
