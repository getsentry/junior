import { http, HttpResponse } from "msw";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export function resetGitHubApiMockState(): void {}

export const githubApiHandlers = [
  http.post(
    `${GITHUB_API_ORIGIN}/app/installations/:installationId/access_tokens`,
    () =>
      HttpResponse.json({
        token: "eval-github-installation-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
  ),
];
