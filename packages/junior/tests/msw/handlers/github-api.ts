import { http, HttpResponse } from "msw";
import { DEFAULT_TEST_EXPIRES_AT_ISO } from "../../fixtures/vitest";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export function resetGitHubApiMockState(): void {}

export const githubApiHandlers = [
  http.post(
    `${GITHUB_API_ORIGIN}/app/installations/:installationId/access_tokens`,
    () =>
      HttpResponse.json({
        token: "eval-github-installation-token",
        expires_at: DEFAULT_TEST_EXPIRES_AT_ISO,
      }),
  ),
];
