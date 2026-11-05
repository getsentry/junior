import { generateKeyPairSync } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "../src/index";
import {
  recordGitHubPullRequestOpener,
  recordGitHubPullRequestRequester,
} from "../src/pull-request-requesters/store";
import {
  GITHUB_REQUEST_ATTRIBUTION_END,
  GITHUB_REQUEST_ATTRIBUTION_START,
} from "../src/tool-support/attribution";
import { createGitHubFixture } from "./github-db";
import { mswServer } from "./msw";

const USER: User = {
  displayName: "David Cramer",
  email: "david@example.com",
  id: "user-1",
  identities: [
    {
      displayName: "David Cramer",
      handle: "david",
      id: "slack-identity",
      provider: "slack",
      providerSubjectId: "U039RR91S",
      providerTenantId: "T1",
    },
    {
      handle: "dcramer_sentry",
      id: "github-identity",
      provider: "github",
      providerSubjectId: "1473041",
    },
  ],
};

function body(labels: string): string {
  return `PR body\n\n${GITHUB_REQUEST_ATTRIBUTION_START}\nvia ${labels}.\n${GITHUB_REQUEST_ATTRIBUTION_END}`;
}

function stubInstallation(): void {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
}

describe("GitHub identity linked", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("assigns and mentions the person on open pull requests they asked for", async () => {
    stubInstallation();
    const fixture = await createGitHubFixture();
    const writes: Array<{ body: unknown; method: string; path: string }> = [];
    const pulls: Record<number, unknown> = {
      // Opened for David: assign him and mention him.
      946: {
        assignees: [],
        body: body("**David Cramer**"),
        state: "open",
      },
      // Updated for David: mention him only. Keep the other requester.
      947: {
        assignees: [],
        body: body("**Ana**, **David Cramer**"),
        state: "open",
      },
      // Closed: no change.
      948: { assignees: [], body: body("**David Cramer**"), state: "closed" },
    };
    mswServer.use(
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: "2027-01-01T00:00:00.000Z",
            token: "installation-token",
          }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/:number",
        ({ params }) => HttpResponse.json(pulls[Number(params.number)]),
      ),
      http.all(
        "https://api.github.com/repos/getsentry/junior/*",
        async ({ request }) => {
          writes.push({
            body: await request.json(),
            method: request.method,
            path: new URL(request.url).pathname,
          });
          return HttpResponse.json({});
        },
      ),
    );

    try {
      const db = fixture.db();
      const createdAt = new Date();
      for (const number of [946, 948]) {
        await recordGitHubPullRequestOpener(db, {
          conversationId: "slack:C1:1.000001",
          createdAt,
          identityId: "slack-identity",
          number,
          repositoryFullName: "getsentry/junior",
        });
      }
      await recordGitHubPullRequestOpener(db, {
        conversationId: "slack:C1:1.000002",
        createdAt,
        identityId: "ana-identity",
        number: 947,
        repositoryFullName: "getsentry/junior",
      });
      await recordGitHubPullRequestRequester(db, {
        identityId: "slack-identity",
        number: 947,
        repositoryFullName: "getsentry/junior",
      });

      await githubPlugin().hooks!.identityLinked!({
        cache: {} as any,
        db,
        identity: USER.identities[1]!,
        log: { error() {}, info() {}, warn() {} },
        plugin: { name: "github" },
        user: USER,
      });

      expect(writes).toEqual(
        expect.arrayContaining([
          {
            body: { assignees: ["dcramer_sentry"] },
            method: "POST",
            path: "/repos/getsentry/junior/issues/946/assignees",
          },
          {
            body: { body: body("@dcramer_sentry") },
            method: "PATCH",
            path: "/repos/getsentry/junior/pulls/946",
          },
          {
            body: { body: body("**Ana**, @dcramer_sentry") },
            method: "PATCH",
            path: "/repos/getsentry/junior/pulls/947",
          },
        ]),
      );
      expect(writes).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });
});
