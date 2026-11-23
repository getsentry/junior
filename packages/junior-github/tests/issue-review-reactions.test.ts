import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubIssues } from "../src/db/schema";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import { createPluginHarness, type PluginHarness } from "./plugin-harness";

describe("issue review items and reactions", () => {
  let fixture: GitHubFixture;
  let h: PluginHarness;
  let issueReads: number[];
  let reactionReads: number;
  let reactionCount: number;
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
    issueReads = [];
    reactionReads = 0;
    reactionCount = 2;
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
        "https://api.github.com/repos/getsentry/junior/issues/:number",
        ({ params }) => {
          issueReads.push(Number(params["number"]));
          return HttpResponse.json({
            // A claim assignee without an item reacts too. Its close does
            // nothing.
            assignees: [{ login: "Pat-GH" }, { login: "sam-gh" }],
            reactions: { total_count: reactionCount },
            state: "open",
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/issues/:number/reactions",
        () => {
          reactionReads += 1;
          return HttpResponse.json([
            { content: "+1", user: { login: "pat-gh" } },
            { content: "eyes", user: null },
            { content: "heart", user: { login: "someone-else" } },
          ]);
        },
      ),
    );
    await fixture
      .db()
      .insert(juniorGitHubIssues)
      .values({
        conversationIds: ["slack:C1:1.0"],
        issueId: "9077",
        number: 77,
        openedAt: new Date(now - 60_000),
        repositoryFullName: "getsentry/junior",
        repositoryId: "1",
        state: "open",
        updatedAt: new Date(now - 60_000),
      });
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

  it("closes the item of an assignee who reacted", async () => {
    await h.heartbeat(now);
    expect(h.closedNotices).toEqual([key("pat-gh")]);
    expect(issueReads).toEqual([77]);
    expect(reactionReads).toBe(1);
  });

  it("skips the reactions of an issue that has none", async () => {
    reactionCount = 0;
    await h.heartbeat(now);
    expect(issueReads).toEqual([77]);
    expect(reactionReads).toBe(0);
    expect(h.closedNotices).toEqual([]);
  });

  it("reads the next issues on each heartbeat, then starts over", async () => {
    await fixture
      .db()
      .insert(juniorGitHubIssues)
      .values(
        Array.from({ length: 10 }, (_, index) => ({
          conversationIds: ["slack:C1:1.0"],
          issueId: `91${index}`,
          number: 100 + index,
          openedAt: new Date(now - 50_000 + index),
          repositoryFullName: "getsentry/junior",
          repositoryId: "1",
          state: "open" as const,
          updatedAt: new Date(now),
        })),
      );
    await h.heartbeat(now);
    expect(issueReads.sort((a, b) => a - b)).toEqual([
      77, 100, 101, 102, 103, 104, 105, 106, 107, 108,
    ]);
    issueReads = [];
    await h.heartbeat(now + 60_000);
    expect(issueReads).toEqual([109]);
    issueReads = [];
    await h.heartbeat(now + 120_000);
    expect(issueReads).toHaveLength(10);
  });
});
