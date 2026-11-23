import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubIssueReviewers } from "../src/db/schema";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import { createPluginHarness, type PluginHarness } from "./plugin-harness";

describe("issue review items and reactions", () => {
  let fixture: GitHubFixture;
  let h: PluginHarness;
  let reads: number;
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const key = (login: string) => `issue-review:getsentry/junior#77:${login}`;

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    h = createPluginHarness(fixture);
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "1234+sentry-junior[bot]@users.noreply.github.com",
    );
    reads = 0;
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
        "https://api.github.com/repos/getsentry/junior/issues/77/reactions",
        () => {
          reads += 1;
          return HttpResponse.json([
            { content: "+1", user: { login: "Pat-GH" } },
            { content: "eyes", user: null },
          ]);
        },
      ),
    );
    await fixture
      .db()
      .insert(juniorGitHubIssueReviewers)
      .values(
        ["pat-gh", "sam-gh"].map((login) => ({
          conversationId: "slack:C1:1.0",
          createdAt: new Date(now - 60_000),
          login,
          number: 77,
          repositoryFullName: "getsentry/junior",
        })),
      );
    for (const login of ["pat-gh", "sam-gh"]) {
      await h.inboxItems.forConversation("slack:C1:1.0").upsert({
        assigneeIdentityIds: [`identity-${login}`],
        body: "#77 waits on your review.",
        dedupeKey: key(login),
        title: "Review requested · #77",
        waitsOnAssignees: true,
      });
    }
  });

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
  });

  it("closes the item of a reviewer who reacted, and reads again later", async () => {
    await h.heartbeat(now);
    expect(h.closedNotices).toEqual([key("pat-gh")]);
    const rows = await fixture.db().select().from(juniorGitHubIssueReviewers);
    expect(rows.map((row) => row.login)).toEqual(["sam-gh"]);

    // A read waits a few minutes, so the next heartbeat reads nothing.
    await h.heartbeat(now + 60_000);
    expect(reads).toBe(1);
    await h.heartbeat(now + 6 * 60_000);
    expect(reads).toBe(2);
    expect(h.closedNotices).toEqual([key("pat-gh")]);
  });

  it("dismisses the items of an issue that is gone", async () => {
    mswServer.use(
      http.get(
        "https://api.github.com/repos/getsentry/junior/issues/77/reactions",
        () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await h.heartbeat(now);
    expect(h.closedNotices).toEqual([key("pat-gh"), key("sam-gh")]);
    expect(
      await fixture.db().select().from(juniorGitHubIssueReviewers),
    ).toEqual([]);
  });
});
