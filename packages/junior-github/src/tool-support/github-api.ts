import {
  type PluginEgress,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";

const GITHUB_API_BASE = "https://api.github.com";
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

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
 * `followRedirects` follows GET redirects on the GitHub API host. Set it only
 * when the caller reads the object identity from the response, because the
 * redirect target can be in another repository.
 */
export async function githubApi(
  egress: PluginEgress,
  input: {
    apiVersion?: string;
    body?: unknown;
    followRedirects?: boolean;
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
  const method = input.method ?? "GET";
  let url = `${GITHUB_API_BASE}${input.path}`;
  let response: Response;
  // Egress does not follow redirects, so credentials never reach a new host.
  // GitHub redirects reads of transferred issues and renamed repos to a
  // `/repositories/{id}` path. Follow those hops here, back through egress.
  // Writes are not followed: write policy needs a `/repos/{owner}/{repo}` URL.
  const follow = input.followRedirects === true && method === "GET";
  for (let hop = 0; ; hop++) {
    response = await egress.fetch({
      provider: "github",
      operation: input.operation,
      request: new Request(url, {
        method,
        headers,
        signal: input.signal,
        ...(input.body !== undefined
          ? { body: JSON.stringify(input.body) }
          : undefined),
      }),
    });
    const next = follow ? redirectTarget(response, url) : undefined;
    if (!next || hop >= MAX_REDIRECTS) break;
    await response.body?.cancel();
    url = next;
  }
  return {
    body: await readBody(response),
    ok: response.ok,
    status: response.status,
  };
}

function redirectTarget(response: Response, from: string): string | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;
  const target = new URL(location, from);
  return target.origin === GITHUB_API_BASE ? target.href : undefined;
}

/**
 * Return where a `github.com` attachment URL redirects, through host
 * egress. GitHub signs that address for a short time, so it needs no
 * credential. Egress does not follow the redirect, so the credential never
 * reaches the image host.
 */
export async function githubAttachmentLocation(
  egress: PluginEgress,
  url: string,
): Promise<string | undefined> {
  const response = await egress.fetch({
    provider: "github",
    operation: "github.attachment.get",
    request: new Request(url, { redirect: "manual" }),
  });
  await response.body?.cancel();
  const location = REDIRECT_STATUSES.has(response.status)
    ? response.headers.get("location")
    : null;
  return location ? new URL(location, url).href : undefined;
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
