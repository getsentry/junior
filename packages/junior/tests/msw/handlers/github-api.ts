import { http, HttpResponse } from "msw";
import {
  interceptTestGitHubChecksHttp,
  interceptTestGitHubDraftsHttp,
  interceptTestGitHubIssuesHttp,
  resetTestGitHubHttpFixtures,
} from "@sentry/junior-testing/http";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export function resetGitHubApiMockState(): void {
  resetTestGitHubHttpFixtures();
}

export const githubApiHandlers = [
  http.get(`${GITHUB_API_ORIGIN}/repos/:owner/:repo/deployments`, () =>
    HttpResponse.json([]),
  ),
  // The GitHub plugin reads the installation's permissions before it mints a
  // token, unless the host declares `appPermissions`.
  http.get(`${GITHUB_API_ORIGIN}/app/installations/:installationId`, () =>
    HttpResponse.json({
      permissions: {
        actions: "read",
        checks: "read",
        contents: "read",
        deployments: "read",
        metadata: "read",
        pull_requests: "read",
      },
    }),
  ),
  http.post(
    `${GITHUB_API_ORIGIN}/app/installations/:installationId/access_tokens`,
    () =>
      HttpResponse.json({
        token: "eval-github-installation-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
  ),
  // A failed check event reads githubstatus.com for GitHub incidents.
  http.get("https://www.githubstatus.com/api/v2/incidents.json", () =>
    HttpResponse.json({ incidents: [] }),
  ),
  http.all(/^https:\/\/(api\.)?github\.com\//, async ({ request }) => {
    const url = new URL(request.url);
    // Plugin tools call GitHub in process, so they reach these fixtures here
    // and not through sandbox egress.
    const response =
      (await interceptTestGitHubChecksHttp(request, url)) ??
      (await interceptTestGitHubDraftsHttp(request, url)) ??
      (await interceptTestGitHubIssuesHttp(request, url));
    if (response) return response;
    // A matched MSW handler that returns undefined bypasses the network guard.
    throw new Error(
      `[HTTP MOCK] Unhandled external request: ${request.method} ${request.url}`,
    );
  }),
];
