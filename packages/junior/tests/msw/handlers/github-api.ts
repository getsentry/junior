import { http, HttpResponse } from "msw";
import { interceptTestGitHubChecksHttp } from "@sentry/junior-testing/http";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export function resetGitHubApiMockState(): void {}

export const githubApiHandlers = [
  http.get(`${GITHUB_API_ORIGIN}/repos/:owner/:repo/deployments`, () =>
    HttpResponse.json([]),
  ),
  http.post(
    `${GITHUB_API_ORIGIN}/app/installations/:installationId/access_tokens`,
    () =>
      HttpResponse.json({
        token: "eval-github-installation-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
  ),
  http.all(/^https:\/\/(api\.)?github\.com\//, async ({ request }) => {
    const response = await interceptTestGitHubChecksHttp(
      request,
      new URL(request.url),
    );
    if (response) return response;
    // A matched MSW handler that returns undefined bypasses the network guard.
    throw new Error(
      `[HTTP MOCK] Unhandled external request: ${request.method} ${request.url}`,
    );
  }),
];
