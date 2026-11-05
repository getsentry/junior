import {
  type PluginEgress,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";

const GITHUB_API_BASE = "https://api.github.com";

/** A GitHub API reply with its body parsed as JSON, or as text when it is not JSON. */
export interface GitHubApiResponse {
  body: unknown;
  ok: boolean;
  status: number;
}

/**
 * Send one GitHub API request through host egress.
 *
 * Egress injects credentials, so tools never see a token. `operation` names
 * the provider action for grant selection and diagnostics. Callers own the
 * error mapping, because the status that means bad input differs per route.
 */
export async function githubApi(
  egress: PluginEgress,
  input: {
    apiVersion?: string;
    body?: unknown;
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    operation: string;
    path: string;
    signal?: AbortSignal;
  },
): Promise<GitHubApiResponse> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": input.apiVersion ?? "2022-11-28",
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await egress.fetch({
    provider: "github",
    operation: input.operation,
    request: new Request(`${GITHUB_API_BASE}${input.path}`, {
      method: input.method ?? "GET",
      headers,
      signal: input.signal,
      ...(input.body !== undefined
        ? { body: JSON.stringify(input.body) }
        : undefined),
    }),
  });
  return {
    body: await readBody(response),
    ok: response.ok,
    status: response.status,
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Return the `/repos/{owner}/{name}` API path prefix for a parsed repo. */
export function repoPath(repo: { name: string; owner: string }): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Parse a model-supplied `owner/name` repository reference. */
export function parseRepo(value: string): {
  name: string;
  owner: string;
  ref: string;
} {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

/**
 * Return a readable error from a GitHub REST or GraphQL error body.
 *
 * REST validation errors list the failed fields in `errors`, and GraphQL puts
 * every message in `errors`. Both details help the model fix its input.
 */
export function githubErrorMessage(body: unknown): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (!isRecord(body)) return "GitHub request failed";
  const errors = Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
  if (typeof body.message === "string" && body.message.trim()) {
    const details = errors
      .map((error) =>
        ["resource", "field", "code", "message"]
          .map((name) => {
            const value = error[name];
            return typeof value === "string" && value.trim()
              ? `${name}=${value.trim()}`
              : undefined;
          })
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean)
      .join("; ");
    const message = body.message.trim();
    return details ? `${message}: ${details}` : message;
  }
  const graphqlMessages = errors
    .map((error) => error.message)
    .filter((message) => typeof message === "string" && message.trim());
  return graphqlMessages.length
    ? graphqlMessages.join("; ")
    : "GitHub request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
