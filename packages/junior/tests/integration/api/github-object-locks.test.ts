import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb } from "@/chat/db";
import {
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  sendGitHubWebhook,
  stubGitHubApp,
  viewerApi,
} from "../../fixtures/github-objects";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";

// A webhook waits for a card read that loads the same object, then gives up.
describe("GitHub webhooks during a slow card read", () => {
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

  it("keeps a webhook that could not wait for a slow card read", async () => {
    stubGitHubApp();
    const issue = {
      closed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      html_url: `${GITHUB_REPO}/issues/15`,
      id: 15_000,
      number: 15,
      state: "open",
      title: "Read me slowly",
      updated_at: "2026-01-02T03:04:05Z",
      user: { login: "byk" },
    };
    const closed = {
      ...issue,
      closed_at: "2026-01-02T04:00:00Z",
      state: "closed",
      updated_at: "2026-01-02T04:00:00Z",
    };
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    let reachedGitHub = gate();
    let answered = gate();
    // The first read answers late, with the issue from before the webhook.
    let slowAnswer: object | undefined = issue;
    let reads = 0;
    mswServer.use(
      http.get(`${GITHUB_API}/issues/15`, async () => {
        reads += 1;
        const answer = slowAnswer;
        if (!answer) return HttpResponse.json(closed);
        slowAnswer = undefined;
        reachedGitHub.open();
        await answered.opened;
        return HttpResponse.json(answer);
      }),
    );
    try {
      const app = await createGitHubApp();
      setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
      await linkGitHubMember();
      const read = await viewerApi("alice@example.com");
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      const slowRead = read(`${GITHUB_REPO}/issues/15`);
      await reachedGitHub.opened;
      // The webhook waits for the read's lock, then gives up.
      const webhook = sendGitHubWebhook(app, "issues", {
        action: "closed",
        issue: closed,
      });
      // Move the clock past the wait until the webhook gives up.
      let settled = false;
      void webhook.finally(() => {
        settled = true;
      });
      for (let step = 1; !settled; step += 1) {
        vi.setSystemTime(start + step * 11_000);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await webhook;
      answered.open();
      await slowRead;

      const next = await read(`${GITHUB_REPO}/issues/15`);
      expect(next.objects.get(`${GITHUB_REPO}/issues/15`)).toMatchObject({
        status: "closed",
      });

      // A later slow read outlives the webhook's mark. The mark expires,
      // but no write came, so the read keeps what it stored.
      vi.setSystemTime(Date.now() + 120_000);
      reachedGitHub = gate();
      answered = gate();
      slowAnswer = closed;
      const readsBefore = reads;
      const lateRead = read(`${GITHUB_REPO}/issues/15`);
      await reachedGitHub.opened;
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      answered.open();
      await lateRead;
      await read(`${GITHUB_REPO}/issues/15`);
      expect(reads).toBe(readsBefore + 1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a deleted issue gone when its webhook could not wait for a card read", async () => {
    stubGitHubApp();
    const issue = {
      closed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      html_url: `${GITHUB_REPO}/issues/16`,
      id: 16_000,
      number: 16,
      state: "open",
      title: "Delete me",
      updated_at: "2026-01-02T03:04:05Z",
      user: { login: "byk" },
    };
    let reachGitHub!: () => void;
    const reachedGitHub = new Promise<void>((resolve) => {
      reachGitHub = resolve;
    });
    let answerGitHub!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerGitHub = resolve;
    });
    // The first read answers late, with the issue from before the delete.
    // GitHub then fails once, and after that says the issue is gone.
    let reads = 0;
    mswServer.use(
      http.get(`${GITHUB_API}/issues/16`, async () => {
        reads += 1;
        if (reads === 2) {
          return HttpResponse.json(
            { message: "Server Error" },
            { status: 502 },
          );
        }
        if (reads > 2) return new HttpResponse(null, { status: 410 });
        reachGitHub();
        await answered;
        return HttpResponse.json(issue);
      }),
      http.get(
        `${GITHUB_REPO}/issues/16`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    try {
      const app = await createGitHubApp();
      setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
      await linkGitHubMember();
      const read = await viewerApi("alice@example.com");
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      const slowRead = read(`${GITHUB_REPO}/issues/16`);
      await reachedGitHub;
      // The delete waits for the read's lock, then gives up.
      const webhook = sendGitHubWebhook(app, "issues", {
        action: "deleted",
        issue,
      });
      let settled = false;
      void webhook.finally(() => {
        settled = true;
      });
      for (let step = 1; !settled; step += 1) {
        vi.setSystemTime(start + step * 11_000);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await webhook;
      answerGitHub();
      await slowRead;
      // A delivery from before the delete comes late.
      await sendGitHubWebhook(app, "issues", {
        action: "edited",
        changes: { title: { from: "Delete this" } },
        issue,
      });

      const next = await read(`${GITHUB_REPO}/issues/16`);
      expect(next.objects.has(`${GITHUB_REPO}/issues/16`)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
