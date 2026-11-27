import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { juniorConversationParticipants } from "@/db/schema";
import {
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  stubGitHubApp,
  viewerApi,
} from "../../fixtures/github-objects";
import { signedInViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const CONVERSATION_ID = "slack:CPRIVATE:1712345.0001";
const PULL_URL = `${GITHUB_REPO}/pull/35`;

async function attachAsAlice(url: string) {
  const viewer = await signedInViewer("alice@example.com");
  await getConversationStore().recordActivity({
    conversationId: CONVERSATION_ID,
    destination: { channelId: "CPRIVATE", platform: "slack", teamId: "T123" },
    nowMs: Date.now(),
    source: "slack",
    title: "Plan the release",
    visibility: "private",
  });
  await getDb().insert(juniorConversationParticipants).values({
    lastMessageAt: new Date(),
    rootConversationId: CONVERSATION_ID,
    userId: viewer.id,
  });
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/annotations`,
    {
      body: JSON.stringify({ url }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return response.status;
}

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

  it("skips GitHub for every link to a pull request on a page that ran out of time, and reads it on Attach", async () => {
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

    // An Attach is not part of the page, so it asks GitHub.
    expect(await attachAsAlice(PULL_URL)).toBe(200);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("shows a stale pull request card without its title parts, and reads no release config, on a page that ran out of time", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    let graphqlCalls = 0;
    let reachGitHub!: () => void;
    const reachedGitHub = new Promise<void>((resolve) => {
      reachGitHub = resolve;
    });
    let answerGitHub!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerGitHub = resolve;
    });
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
          title: "feat(inbox): Pin the release",
          updated_at: "2026-01-02T03:00:00Z",
          user: { login: "byk" },
        });
      }),
      // A failed read of the release config is not cached.
      http.get(`${GITHUB_API}/contents/.github/release.yml`, () => {
        reads.push("release.yml");
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
      // The first page's card query fails at once. The next one answers
      // late, and fails.
      http.post("https://api.github.com/graphql", async () => {
        graphqlCalls += 1;
        reads.push("graphql");
        if (graphqlCalls === 1) {
          return HttpResponse.json(
            { message: "Server Error" },
            { status: 502 },
          );
        }
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
    // The first page caches the pull request, but not its release config.
    expect((await read(PULL_URL)).objects.has(PULL_URL)).toBe(true);
    expect(reads).toContain("release.yml");
    // Its cache entry goes stale, and the next page runs out of time.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    reads.length = 0;
    const page = read(PULL_URL);
    await reachedGitHub;
    vi.setSystemTime(Date.now() + 21_000);
    answerGitHub();
    const { objects } = await page;
    const card = objects.get(PULL_URL);
    expect(card?.title).toBe("feat(inbox): Pin the release");
    expect(
      card?.facts?.type === "code_change" ? card.facts.titleParts : undefined,
    ).toBeUndefined();
    expect(reads).toEqual(["graphql"]);
  });
});
