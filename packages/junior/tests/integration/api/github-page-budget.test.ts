import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb } from "@/chat/db";
import {
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  stubGitHubApp,
  viewerApi,
} from "../../fixtures/github-objects";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const PULL_URL = `${GITHUB_REPO}/pull/35`;

// A page waits at most 20 s for its card queries. The cards that it ran out
// of time for show only what the cache holds, on that page only.
describe("GitHub card reads after a page runs out of time", () => {
  let previousDashboard: ReturnType<typeof setDashboardConversationLinkOptions>;

  beforeEach(() => {
    previousDashboard = setDashboardConversationLinkOptions({
      baseURL: DASHBOARD,
    });
  });

  afterEach(async () => {
    setDashboardConversationLinkOptions(previousDashboard);
    vi.useRealTimers();
    await closeDb();
  });

  it("skips GitHub for every link to a pull request on a page that ran out of time", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/35`, () => {
        reads.push("pulls/35");
        return HttpResponse.json({
          base: { ref: "main" },
          created_at: "2026-01-01T00:00:00Z",
          draft: false,
          head: { ref: "feat/release", sha: "aaa111" },
          html_url: PULL_URL,
          mergeable: true,
          merged: false,
          number: 35,
          state: "open",
          title: "Pin the release",
          updated_at: "2026-01-02T03:00:00Z",
          user: { login: "byk" },
        });
      }),
    );
    let reachGitHub!: () => void;
    const reachedGitHub = new Promise<void>((resolve) => {
      reachGitHub = resolve;
    });
    let answerGitHub!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerGitHub = resolve;
    });
    // The page's card query answers late, and fails.
    mswServer.use(
      http.post("https://api.github.com/graphql", async () => {
        reads.push("graphql");
        reachGitHub();
        await answered;
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    await createGitHubApp();
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    // The page links the pull request twice.
    const page = read(PULL_URL, `${PULL_URL}#discussion_r1`);
    await reachedGitHub;
    vi.setSystemTime(Date.now() + 21_000);
    answerGitHub();
    // The page shows no card yet, and makes no read of its own.
    const { objects } = await page;
    expect(objects.has(PULL_URL)).toBe(false);
    expect(objects.has(`${PULL_URL}#discussion_r1`)).toBe(false);
    expect(reads).toEqual(["graphql"]);
  });
});
