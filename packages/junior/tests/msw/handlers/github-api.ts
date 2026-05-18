import { http, HttpResponse } from "msw";

export interface CapturedGitHubApiCall {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  params: Record<string, string>;
  url: string;
}

const capturedGitHubApiCalls: CapturedGitHubApiCall[] = [];
let nextCommentId = 10_000;

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

function buildGitHubCommentResponse(args: { body: string; id?: number }) {
  const id = args.id ?? nextCommentId++;
  const now = new Date().toISOString();
  const botLogin = process.env.GITHUB_BOT_USERNAME ?? "junior-bot";
  return {
    id,
    body: args.body,
    html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}`,
    created_at: now,
    updated_at: now,
    user: {
      id: 987_654,
      login: botLogin,
      type: "Bot",
    },
  };
}

export function getCapturedGitHubApiCalls(): CapturedGitHubApiCall[] {
  return [...capturedGitHubApiCalls];
}

export function resetGitHubApiMockState(): void {
  capturedGitHubApiCalls.length = 0;
  nextCommentId = 10_000;
}

export const githubApiHandlers = [
  http.get("https://api.github.com/user", async ({ request }) => {
    capturedGitHubApiCalls.push({
      method: "GET",
      url: request.url,
      headers: normalizeHeaders(request.headers),
      params: {},
      body: undefined,
    });

    return HttpResponse.json({
      id: 987_654,
      login: process.env.GITHUB_BOT_USERNAME ?? "junior-bot",
      type: "Bot",
    });
  }),

  http.post(
    "https://api.github.com/repos/:owner/:repo/issues/:issue_number/comments",
    async ({ params, request }) => {
      const payload = (await request.json()) as { body?: string };
      capturedGitHubApiCalls.push({
        method: "POST",
        url: request.url,
        headers: normalizeHeaders(request.headers),
        params: params as Record<string, string>,
        body: payload,
      });

      return HttpResponse.json(
        buildGitHubCommentResponse({ body: payload.body ?? "" }),
      );
    },
  ),

  http.post(
    "https://api.github.com/repos/:owner/:repo/pulls/:pull_number/comments/:comment_id/replies",
    async ({ params, request }) => {
      const payload = (await request.json()) as { body?: string };
      capturedGitHubApiCalls.push({
        method: "POST",
        url: request.url,
        headers: normalizeHeaders(request.headers),
        params: params as Record<string, string>,
        body: payload,
      });

      return HttpResponse.json(
        buildGitHubCommentResponse({ body: payload.body ?? "" }),
      );
    },
  ),
];
