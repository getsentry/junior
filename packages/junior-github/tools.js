import { PluginToolInputError } from "@sentry/junior-plugin-api";

const GITHUB_ISSUE_FOOTER_START = "<!-- junior-session-footer:start -->";
const GITHUB_ISSUE_FOOTER_END = "<!-- junior-session-footer:end -->";
const GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_ISSUE_CREATE_LOCK_TTL_MS = 60_000;

class GitHubIssueCreateRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubIssueCreateRejectedError";
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginToolInputError(`${name} is required`);
  }
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PluginToolInputError(`${name} must be a string`);
  }
  return value;
}

function optionalStringList(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new PluginToolInputError(`${name} must be an array`);
  }
  const entries = value.map((entry) => requiredString(entry, `${name} entry`));
  return entries.length ? entries : undefined;
}

function parseRepo(value) {
  const repo = requiredString(value, "repo");
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return {
    owner: parts[0].trim(),
    name: parts[1].trim(),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function githubIssueConversationFooter(conversationId) {
  const id = requiredString(conversationId, "conversationId");
  return `${GITHUB_ISSUE_FOOTER_START}\n\n---\nCreated by Junior.\nConversation: \`${id}\`\n\n${GITHUB_ISSUE_FOOTER_END}`;
}

function appendGitHubIssueFooter(body, conversationId) {
  const footer = githubIssueConversationFooter(conversationId);
  const normalizedBody = body.trimEnd();
  const existingFooter = new RegExp(
    `${escapeRegExp(GITHUB_ISSUE_FOOTER_START)}[\\s\\S]*?${escapeRegExp(
      GITHUB_ISSUE_FOOTER_END,
    )}`,
  );
  if (existingFooter.test(normalizedBody)) {
    return normalizedBody.replace(existingFooter, footer);
  }
  return normalizedBody ? `${normalizedBody}\n\n${footer}` : footer;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubApiErrorMessage(payload) {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  return "GitHub request failed";
}

function createIssueResult(value) {
  if (
    isRecord(value) &&
    value.status === "completed" &&
    typeof value.number === "number" &&
    typeof value.url === "string"
  ) {
    return {
      number: value.number,
      url: value.url,
    };
  }
  return undefined;
}

function isPendingCreateIssue(value) {
  return isRecord(value) && value.status === "pending";
}

function createGitHubIssueRequest(ctx, input) {
  const repo = parseRepo(input.repo);
  const title = requiredString(input.title, "title");
  const body = optionalString(input.body, "body") ?? "";
  const labels = optionalStringList(input.labels, "labels");
  const payload = {
    title,
    body: appendGitHubIssueFooter(body, ctx.conversationId),
    ...(labels ? { labels } : {}),
  };
  return new Request(
    `https://api.github.com/repos/${encodeURIComponent(
      repo.owner,
    )}/${encodeURIComponent(repo.name)}/issues`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    },
  );
}

async function createGitHubIssue(ctx, request) {
  const response = await ctx.egress.fetch({
    provider: "github",
    operation: "github.issue.create",
    request,
  });
  const parsed = await readJsonResponse(response);
  if (!response.ok) {
    throw new GitHubIssueCreateRejectedError(
      `GitHub issue creation failed with HTTP ${response.status}: ${githubApiErrorMessage(
        parsed,
      )}`,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.number !== "number" ||
    typeof parsed.html_url !== "string"
  ) {
    throw new Error("GitHub issue creation returned an invalid response.");
  }
  return {
    number: parsed.number,
    url: parsed.html_url,
  };
}

/** Own issue creation so provider writes use host egress and the footer stays deterministic. */
export function createGitHubIssueTool(ctx) {
  return {
    description:
      "Create a GitHub issue with a runtime-owned Junior conversation footer. Use this instead of shelling out to gh issue create when creating issues.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "title"],
      properties: {
        repo: {
          type: "string",
          description: 'Repository in "owner/name" format.',
        },
        title: {
          type: "string",
          description: "Issue title.",
        },
        body: {
          type: "string",
          description: "Issue body. Junior appends the conversation footer.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply to the issue.",
        },
      },
    },
    async execute(input, options) {
      const conversationId = requiredString(
        ctx.conversationId,
        "conversationId",
      );
      const toolCallId = requiredString(options?.toolCallId, "toolCallId");
      const key = `createIssue:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(
        `${key}:lock`,
        GITHUB_ISSUE_CREATE_LOCK_TTL_MS,
        async () => {
          const existing = createIssueResult(await ctx.state.get(key));
          if (existing) {
            return existing;
          }
          if (isPendingCreateIssue(await ctx.state.get(key))) {
            throw new Error(
              "GitHub issue creation for this tool call has an uncertain pending result; refusing to create a duplicate issue.",
            );
          }
          const request = createGitHubIssueRequest(ctx, input);
          await ctx.state.set(
            key,
            { status: "pending", createdAtMs: Date.now() },
            GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS,
          );
          try {
            const result = await createGitHubIssue(ctx, request);
            await ctx.state.set(
              key,
              { status: "completed", ...result },
              GITHUB_ISSUE_CREATE_IDEMPOTENCY_TTL_MS,
            );
            return result;
          } catch (error) {
            if (error instanceof GitHubIssueCreateRejectedError) {
              await ctx.state.delete(key);
            }
            throw error;
          }
        },
      );
    },
  };
}
