import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { githubPlugin } from "@sentry/junior-github";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/hooks/tools";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorInboxItems } from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackSpawnInput,
  slackParentConversationId,
} from "../fixtures/child-agents";
import { seedLinkedPerson } from "../fixtures/slack-user";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { signedInViewer } from "../fixtures/user";
import { mswServer } from "../msw/server";

const API = "https://api.github.com/repos/getsentry/junior/pulls/1592";
const PULL_URL = "https://github.com/getsentry/junior/pull/1592";
// GitHub's id of the pull request, which names its Inbox item.
const PULL_ID = "1592000";
const BOT = "sentry-junior[bot]";
const person = slackSpawnInput.actor;

let app: Awaited<ReturnType<typeof createApp>>;

/** Send a signed GitHub webhook through the app route. */
async function sendGitHubWebhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { full_name: "getsentry/junior", id: 2001 },
    sender: { login: BOT },
    ...payload,
  });
  const response = await app.fetch(
    new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": `delivery-${event}-${Date.now()}`,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
          .update(body)
          .digest("hex")}`,
      },
      body,
    }),
  );
  expect(response.status).toBe(202);
}

/** The pull request in a `pull_request` webhook. */
function pullRequest(body: string, merged: boolean, updatedAt: string) {
  return {
    body,
    closed_at: merged ? updatedAt : null,
    created_at: "2026-07-01T12:00:00.000Z",
    draft: false,
    id: Number(PULL_ID),
    merged,
    merged_at: merged ? updatedAt : null,
    number: 1592,
    title: "fix: Check",
    updated_at: updatedAt,
    user: { login: BOT },
  };
}

/** The state of the pull request's ask. */
async function askStatus() {
  const [ask] = await getDb()
    .select({ status: juniorInboxItems.status })
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.subjectId, PULL_ID));
  return ask?.status;
}

/** Open pull request #1592 from the person's Turn, as Junior does. */
async function openPullRequest(): Promise<string> {
  const opened: string[] = [];
  await getPluginTools({
    actor: person,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    egress: {
      fetch: async ({ request }) => {
        if (request.method === "POST" && request.url.endsWith("/pulls")) {
          opened.push(((await request.json()) as { body: string }).body);
        }
        return Response.json(
          { html_url: PULL_URL, number: 1592 },
          { status: 201 },
        );
      },
    },
    resolveActorIdentity: async () => await readActorIdentity(person),
    source: { kind: "parent_message" },
    turnTools: turnBehavior({
      kind: "task",
      hasParent: true,
      personInput: false,
    }).tools,
    workspace: {} as never,
  })["github_createPullRequest"]!.execute!(
    {
      base: "main",
      body: "Fix the check.",
      head: "fix/check",
      repo: "getsentry/junior",
      title: "fix: Check",
    },
    { toolCallId: "create-pull-request" },
  );
  return opened[0]!;
}

describe("the ask of a Junior pull request", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
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
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await disconnectStateAdapter();
  });

  it("closes the ask when the pull request merges, and changes no Annotation", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const requester = await upsertIdentity(getSqlExecutor(), {
      displayName: "Pat Requester",
      email: "pat@example.com",
      emailVerified: true,
      kind: "user",
      provider: "slack",
      providerSubjectId: person.userId,
      providerTenantId: person.teamId,
    });
    // A merge ask needs the requester's GitHub login, to read their access.
    if (!requester.userId) throw new Error("missing requester user");
    await upsertLinkedIdentity(getSqlExecutor(), requester.userId, {
      handle: "pat-requester",
      kind: "user",
      provider: "github",
      providerSubjectId: "1001",
    });
    const { fixture } = await prepareSlackParentConversation();
    // The footer that links the pull request to its Conversation needs a
    // dashboard link.
    const previousDashboard = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      const github = { merged: false };
      mswServer.use(
        http.get(API, async () => {
          return HttpResponse.json({
            auto_merge: null,
            draft: false,
            head: { sha: "head-1" },
            html_url: PULL_URL,
            mergeable_state: "clean",
            merged: github.merged,
            requested_reviewers: [],
            state: github.merged ? "closed" : "open",
            title: "fix: Check",
            user: { id: 264270552 },
          });
        }),
        // The next-action check reads the pull request and its reviews.
        http.post("https://api.github.com/graphql", async () => {
          return HttpResponse.json({
            data: {
              repository: {
                pullRequest: {
                  autoMergeRequest: null,
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewRequests: { nodes: [] },
                  reviews: {
                    nodes: [
                      {
                        author: { __typename: "User", login: "sam" },
                        commit: { oid: "head-1" },
                        state: "APPROVED",
                        submittedAt: "2026-07-02T12:00:00Z",
                      },
                    ],
                    pageInfo: { hasPreviousPage: false, startCursor: null },
                  },
                  state: github.merged ? "MERGED" : "OPEN",
                  timelineItems: { nodes: [] },
                  title: "fix: Check",
                  url: PULL_URL,
                },
              },
            },
          });
        }),
        // The requester has write access, so they get the merge ask.
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/pat-requester/permission",
          () => HttpResponse.json({ permission: "write", role_name: "write" }),
        ),
        http.get(`${API}/commits`, async () => {
          return HttpResponse.json([]);
        }),
      );

      const body = await openPullRequest();
      await sendGitHubWebhook("pull_request", {
        action: "opened",
        pull_request: pullRequest(body, false, "2026-07-01T12:00:00.000Z"),
      });
      await sendGitHubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 1592, user: { login: BOT } },
        review: { state: "approved", user: { login: "sam" } },
      });
      expect(await askStatus()).toBe("open");
      const annotations = () =>
        listConversationAnnotations(getDb(), slackParentConversationId);
      const before = await annotations();

      github.merged = true;
      await sendGitHubWebhook("pull_request", {
        action: "closed",
        pull_request: pullRequest(body, true, "2026-07-03T12:00:00.000Z"),
      });

      expect(await askStatus()).toBe("done");
      // Cards read the pull request live, so the merge writes no Annotation.
      expect(await annotations()).toEqual(before);
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
  it("asks for the review, then the merge, on one item that reads its title from GitHub", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    const { fixture } = await prepareSlackParentConversation();
    const previousDashboard = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      const github = { approved: false };
      // The title on GitHub changed after Junior opened the pull request.
      const title = "fix: Check the build";
      let cardReads = 0;
      // Runs once while a card read waits on GitHub.
      let duringCardRead: (() => Promise<void>) | undefined;
      mswServer.use(
        http.get(API, () =>
          HttpResponse.json({
            auto_merge: null,
            draft: false,
            head: { sha: "head-1" },
            html_url: PULL_URL,
            mergeable_state: "clean",
            merged: false,
            requested_reviewers: github.approved ? [] : [{ login: "pat" }],
            state: "open",
            title,
            user: { id: 264270552 },
          }),
        ),
        http.get(`${API}/commits`, () => HttpResponse.json([])),
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/pat/permission",
          () => HttpResponse.json({ permission: "write" }),
        ),
        http.post("https://api.github.com/graphql", async ({ request }) => {
          const { query } = (await request.json()) as { query: string };
          if (query.includes("PullRequestCards")) {
            cardReads += 1;
            const reviewDecision = github.approved ? "APPROVED" : null;
            const during = duringCardRead;
            duringCardRead = undefined;
            await during?.();
            return HttpResponse.json({
              data: {
                p0: {
                  pullRequest: {
                    additions: 1,
                    author: { login: BOT },
                    baseRefName: "main",
                    body: "",
                    changedFiles: 1,
                    commits: { nodes: [] },
                    deletions: 1,
                    headRefName: "fix/check",
                    headRefOid: "head-1",
                    isDraft: false,
                    mergeable: "MERGEABLE",
                    merged: false,
                    number: 1592,
                    reviewDecision,
                    reviewRequests: { nodes: [] },
                    state: "OPEN",
                    title,
                    updatedAt: "2026-07-02T12:00:00Z",
                    url: PULL_URL,
                  },
                },
              },
            });
          }
          // The next-action check reads the pull request and its reviews.
          return HttpResponse.json({
            data: {
              repository: {
                pullRequest: {
                  autoMergeRequest: null,
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  mergeStateStatus: "CLEAN",
                  reviewRequests: {
                    nodes: github.approved
                      ? []
                      : [
                          {
                            requestedReviewer: {
                              __typename: "User",
                              login: "pat",
                            },
                          },
                        ],
                  },
                  reviews: {
                    nodes: github.approved
                      ? [
                          {
                            author: { __typename: "User", login: "pat" },
                            commit: { oid: "head-1" },
                            state: "APPROVED",
                            submittedAt: "2026-07-02T12:00:00Z",
                          },
                        ]
                      : [],
                    pageInfo: { hasPreviousPage: false, startCursor: null },
                  },
                  state: "OPEN",
                  timelineItems: { nodes: [] },
                  title,
                  url: PULL_URL,
                },
              },
            },
          });
        }),
      );

      const body = await openPullRequest();
      await sendGitHubWebhook("pull_request", {
        action: "opened",
        pull_request: pullRequest(body, false, "2026-07-01T12:00:00.000Z"),
      });
      await sendGitHubWebhook("pull_request", {
        action: "review_requested",
        pull_request: pullRequest(body, false, "2026-07-01T12:01:00.000Z"),
        requested_reviewer: { login: "pat" },
      });
      const [review] = await getDb()
        .select({ id: juniorInboxItems.id })
        .from(juniorInboxItems)
        .where(eq(juniorInboxItems.subjectId, PULL_ID));
      github.approved = true;
      await sendGitHubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 1592, user: { login: BOT } },
        review: { state: "approved", user: { login: "pat" } },
      });

      // The item stores no link, and its Slack card title still links to
      // the pull request, from the code change records.
      expect(
        JSON.stringify([
          ...slackApiOutbox.calls("chat.postMessage"),
          ...slackApiOutbox.calls("chat.update"),
        ]),
      ).toContain(`](${PULL_URL})**`);
      // The subject names one item, so the merge ask is the same item.
      expect(
        await getDb()
          .select({
            id: juniorInboxItems.id,
            status: juniorInboxItems.status,
            subjectKind: juniorInboxItems.subjectKind,
          })
          .from(juniorInboxItems)
          .where(eq(juniorInboxItems.subjectId, PULL_ID)),
      ).toEqual([
        { id: review!.id, status: "open", subjectKind: "github:pull_request" },
      ]);

      const viewer = await signedInViewer("pat@example.com");
      const api = new Hono<JuniorApiEnv>();
      api.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      api.route("/", createJuniorApi());
      const response = await api.request(
        "http://localhost/api/inbox-items?for=viewer",
      );
      expect(response.status).toBe(200);
      const { items } = (await response.json()) as {
        items: Array<{ id: string; subject: Record<string, unknown> }>;
      };
      // The label is the viewer's ask on the live pull request. The title
      // is GitHub's title now, from one read for the page, and no Inbox
      // column stores it.
      expect(items).toMatchObject([
        {
          id: review!.id,
          subject: {
            id: PULL_ID,
            kind: "github:pull_request",
            label: "Ready to merge",
            object: { title, url: PULL_URL },
            url: PULL_URL,
          },
        },
      ]);
      expect(cardReads).toBe(1);

      // Pat's approval is dismissed while a page waits on the card read
      // that a new review started. GitHub answered that read before the
      // dismissal, so its approval does not stay, and the next page reads
      // the decision again.
      await sendGitHubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 1592, user: { login: BOT } },
        review: { state: "commented", user: { login: "sam" } },
      });
      duringCardRead = async () => {
        github.approved = false;
        await sendGitHubWebhook("pull_request_review", {
          action: "dismissed",
          pull_request: { number: 1592, user: { login: BOT } },
          review: { state: "dismissed", user: { login: "pat" } },
        });
      };
      const label = async () => {
        const page = await api.request(
          "http://localhost/api/inbox-items?for=viewer",
        );
        const read = (await page.json()) as {
          items: Array<{ id: string; subject: { label?: string } }>;
        };
        return read.items.find((item) => item.id === review!.id)?.subject.label;
      };
      await label();
      expect(cardReads).toBe(2);
      expect(await label()).toBe("Review requested");
      expect(cardReads).toBe(3);
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
});
