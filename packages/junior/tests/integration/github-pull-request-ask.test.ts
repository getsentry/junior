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
import { recordConversationParticipant } from "@/chat/conversations/sql/participants";
import { getDb, getSqlExecutor } from "@/chat/db";
import { getPluginTools } from "@/chat/plugins/hooks/tools";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorInboxItemAssignees,
  juniorInboxItems,
  juniorUsers,
} from "@/db/schema";
import type { InboxItemPayload } from "@/api/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackSpawnInput,
  slackParentConversationId,
} from "../fixtures/child-agents";
import {
  readLiveCards,
  recordOutboundRequests,
} from "../fixtures/object-cards";
import { seedLinkedPerson } from "../fixtures/slack-user";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { signedInViewer } from "../fixtures/user";
import { mswServer } from "../msw/server";
import { patchConfig } from "../fixtures/config";
import { createPluginTaskQueueTestAdapter } from "../fixtures/plugin-task-queue";

const API = "https://api.github.com/repos/getsentry/junior/pulls/1592";
const PULL_URL = "https://github.com/getsentry/junior/pull/1592";
// GitHub's id of the pull request, which names its Inbox item.
const PULL_ID = "1592000";
const BOT = "sentry-junior[bot]";
const person = slackSpawnInput.actor;

/** The pull request as a `PullRequestCards` query reads it. */
function cardNode(fields: Record<string, unknown>) {
  return {
    additions: 1,
    assignees: { nodes: [] },
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
    reviewRequests: { nodes: [] },
    state: "OPEN",
    updatedAt: "2026-07-02T12:00:00Z",
    url: PULL_URL,
    ...fields,
  };
}

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
    // A pull request item needs a person Junior knows: one for nobody is
    // not added.
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    const { fixture } = await prepareSlackParentConversation();
    // The footer that links the pull request to its Conversation needs a
    // dashboard link.
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
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
                defaultBranchRef: { name: "main" },
                pullRequest: {
                  autoMergeRequest: null,
                  baseRef: null,
                  baseRefName: "main",
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  isInMergeQueue: false,
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
                  updatedAt: "2026-07-02T12:00:00Z",
                  title: "fix: Check",
                  url: PULL_URL,
                },
              },
            },
          });
        }),
        // The requester has write access, so they get the merge ask.
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/pat/permission",
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
      await fixture.close();
    }
  });
  it("asks for the review, then the merge, on one item that reads its title from GitHub", async () => {
    const tasks = createPluginTaskQueueTestAdapter();
    app = await createApp({
      plugins: defineJuniorPlugins([githubPlugin()]),
      pluginTaskQueue: tasks.pluginTaskQueue,
    });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    const { fixture } = await prepareSlackParentConversation();
    patchConfig({ dashboard: { baseURL: "https://junior.example.com" } });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      // GitHub requests Pat's review until Pat reviews.
      const github = { approved: false, requested: true };
      // The title on GitHub changed after Junior opened the pull request.
      const title = "fix: Check the build";
      let cardReads = 0;
      // Runs once while a patch read waits on GitHub.
      let duringPatchRead: (() => Promise<void>) | undefined;
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
          const reviewDecision = github.approved ? "APPROVED" : null;
          if (query.includes("PullRequestHeadFacts")) {
            const during = duringPatchRead;
            duringPatchRead = undefined;
            await during?.();
            return HttpResponse.json({
              data: {
                p0: {
                  pullRequest: {
                    commits: { nodes: [] },
                    databaseId: Number(PULL_ID),
                    headRefOid: "head-1",
                    mergeable: "MERGEABLE",
                    reviewDecision,
                    reviewRequests: { nodes: [] },
                    updatedAt: "2026-07-02T12:00:00Z",
                  },
                },
              },
            });
          }
          if (query.includes("PullRequestCards")) {
            cardReads += 1;
            return HttpResponse.json({
              data: {
                p0: {
                  pullRequest: cardNode({ reviewDecision, title }),
                },
              },
            });
          }
          // The next-action check reads the pull request and its reviews.
          return HttpResponse.json({
            data: {
              repository: {
                defaultBranchRef: { name: "main" },
                pullRequest: {
                  autoMergeRequest: null,
                  baseRef: null,
                  baseRefName: "main",
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  isInMergeQueue: false,
                  mergeStateStatus: "CLEAN",
                  reviewRequests: {
                    nodes: !github.requested
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
                  updatedAt: "2026-07-02T12:00:00Z",
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
      const viewer = await signedInViewer("pat@example.com");
      // A live read, such as the Inbox tools make, stores the card before
      // the review.
      await readLiveCards(viewer, [PULL_URL]);
      expect(cardReads).toBe(1);
      const sendReview = async (state: string, login: string) =>
        await sendGitHubWebhook("pull_request_review", {
          action: state === "dismissed" ? "dismissed" : "submitted",
          pull_request: { head: { sha: "head-1" }, number: 1592 },
          review: { state, user: { login } },
        });
      github.approved = true;
      github.requested = false;
      await sendReview("approved", "pat");

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

      const api = new Hono<JuniorApiEnv>();
      api.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      api.route("/", createJuniorApi());
      // A page reads only the caches. The next-action read of the review
      // webhook wrote the approval into the card, before its patch runs.
      const outbound = recordOutboundRequests();
      const response = await api.request(
        "http://localhost/api/inbox-items?for=viewer",
      );
      outbound.stop();
      expect(outbound.urls).toEqual([]);
      expect(response.status).toBe(200);
      const { items } = (await response.json()) as {
        items: Array<{ id: string; subject: Record<string, unknown> }>;
      };
      // The label is the viewer's ask on the cached pull request. The
      // title is GitHub's title from the card read, and no Inbox column
      // stores it.
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
      // Pat is the requester, with no review request now, so their dismiss
      // changes nothing on GitHub and says nothing more.
      expect(items[0]!.subject).not.toHaveProperty("dismissNote");
      expect(cardReads).toBe(1);

      // Pat's approval is dismissed while the patch that the approval
      // started waits on GitHub. GitHub answered that read before the
      // dismissal, so its approval does not stay.
      await sendReview("commented", "sam");
      duringPatchRead = async () => {
        github.approved = false;
        await sendReview("dismissed", "pat");
      };
      await tasks.deliver();
      const after = recordOutboundRequests();
      const again = (await (
        await api.request("http://localhost/api/inbox-items?for=viewer")
      ).json()) as {
        items: Array<{ id: string; subject: Record<string, unknown> }>;
      };
      after.stop();
      expect(after.urls).toEqual([]);
      // Pat's item asks for a review again, but GitHub asks no review of
      // Pat, so their dismiss still says nothing more.
      expect(again.items[0]!.subject).toMatchObject({
        label: "Review requested",
      });
      expect(again.items[0]!.subject).not.toHaveProperty("dismissNote");
      expect(cardReads).toBe(1);
    } finally {
      await fixture.close();
    }
  });
  it("removes the person who dismisses from the requested reviewers, and a GitHub refusal keeps them", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    const { fixture } = await prepareSlackParentConversation();
    // Pat requested the review from the Conversation.
    const [pat] = await getDb()
      .select({ id: juniorIdentities.id })
      .from(juniorIdentities)
      .where(eq(juniorIdentities.providerSubjectId, person.userId));
    await recordConversationParticipant(getSqlExecutor(), {
      actorIdentityId: pat!.id,
      atMs: Date.now(),
      conversationId: slackParentConversationId,
    });
    patchConfig({ dashboard: { baseURL: "https://junior.example.com" } });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      const github = {
        approved: false,
        gone: false,
        refuse: true,
        reviewers: ["pat"],
      };
      const removed: unknown[] = [];
      mswServer.use(
        http.get(API, () =>
          github.gone
            ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
            : HttpResponse.json({
                auto_merge: null,
                draft: false,
                head: { sha: "head-1" },
                html_url: PULL_URL,
                mergeable_state: "clean",
                merged: false,
                requested_reviewers: github.reviewers.map((login) => ({
                  login,
                })),
                state: "open",
                title: "fix: Check",
                user: { id: 264270552 },
              }),
        ),
        http.delete(`${API}/requested_reviewers`, async ({ request }) => {
          if (github.refuse) {
            return HttpResponse.json(
              { message: "Resource not accessible by integration" },
              { status: 403 },
            );
          }
          removed.push(await request.json());
          github.reviewers = [];
          return HttpResponse.json({ requested_reviewers: [] });
        }),
        http.get(`${API}/commits`, () => HttpResponse.json([])),
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/pat/permission",
          () => HttpResponse.json({ permission: "write" }),
        ),
        http.post("https://api.github.com/graphql", () =>
          HttpResponse.json({
            data: {
              repository: {
                defaultBranchRef: { name: "main" },
                pullRequest: {
                  autoMergeRequest: null,
                  baseRef: null,
                  baseRefName: "main",
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  isInMergeQueue: false,
                  mergeStateStatus: "CLEAN",
                  reviewRequests: {
                    nodes: github.reviewers.map((login) => ({
                      requestedReviewer: { __typename: "User", login },
                    })),
                  },
                  reviews: {
                    // Sam approves after Pat dismissed the review ask.
                    nodes: github.approved
                      ? [
                          {
                            author: { __typename: "User", login: "sam" },
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
                  updatedAt: "2026-07-02T12:00:00Z",
                  title: "fix: Check",
                  url: PULL_URL,
                },
              },
            },
          }),
        ),
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

      const viewer = await signedInViewer("pat@example.com");
      const api = new Hono<JuniorApiEnv>();
      api.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      api.route("/", createJuniorApi());
      const dismiss = async () =>
        await api.request(
          `http://localhost/api/inbox-items/${review!.id}/actions`,
          {
            body: JSON.stringify({ action: "dismiss" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
      const status = async () =>
        (
          await getDb()
            .select({ status: juniorInboxItems.status })
            .from(juniorInboxItems)
            .where(eq(juniorInboxItems.id, review!.id))
        )[0]?.status;

      // GitHub refuses, so the dismiss fails and the item stays open.
      expect((await dismiss()).status).toBe(409);
      expect(await status()).toBe("open");

      github.refuse = false;
      expect((await dismiss()).status).toBe(200);
      expect(removed).toEqual([{ reviewers: ["pat"] }]);
      // Pat was the only person on it, so the item closes.
      expect(await status()).toBe("dismissed");

      // Pat dismissed only the review that GitHub asked of them. They still
      // own the pull request, so the merge ask comes to them once it is
      // approved, on a new item.
      github.approved = true;
      await sendGitHubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 1592, user: { login: BOT } },
        review: { state: "approved", user: { login: "sam" } },
      });
      const inbox = await api.request(
        "http://localhost/api/inbox-items?for=viewer",
      );
      const { items } = (await inbox.json()) as {
        items: Array<{ id: string; subject: { id: string } }>;
      };
      expect(items).toEqual([
        expect.objectContaining({
          subject: expect.objectContaining({ id: PULL_ID }),
        }),
      ]);
      expect(items[0]!.id).not.toBe(review!.id);

      // Once the pull request is gone from GitHub, nobody is left to
      // remove, so a dismiss still takes Pat off the item.
      github.gone = true;
      const dismissGone = await api.request(
        `http://localhost/api/inbox-items/${items[0]!.id}/actions`,
        {
          body: JSON.stringify({ action: "dismiss" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(dismissGone.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
  it("puts a requested reviewer from outside a private Conversation on the item, without the Conversation", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    // Out is not in the pull request's Conversation.
    await seedLinkedPerson({
      email: "out@example.com",
      linked: { handle: "out", provider: "github", subjectId: "2004" },
      slackUserId: "U_OUT",
    });
    const { fixture } = await prepareSlackParentConversation();
    const [pat] = await getDb()
      .select({ id: juniorIdentities.id })
      .from(juniorIdentities)
      .where(eq(juniorIdentities.providerSubjectId, person.userId));
    await recordConversationParticipant(getSqlExecutor(), {
      actorIdentityId: pat!.id,
      atMs: Date.now(),
      conversationId: slackParentConversationId,
    });
    await getDb().update(juniorDestinations).set({ visibility: "private" });
    await getDb().update(juniorConversations).set({ visibility: "private" });
    patchConfig({ dashboard: { baseURL: "https://junior.example.com" } });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      const github = { reviewers: ["nolink"] };
      const removed: unknown[] = [];
      mswServer.use(
        http.get(API, () =>
          HttpResponse.json({
            auto_merge: null,
            draft: false,
            head: { sha: "head-1" },
            html_url: PULL_URL,
            mergeable_state: "clean",
            merged: false,
            requested_reviewers: github.reviewers.map((login) => ({ login })),
            state: "open",
            title: "fix: Check",
            user: { id: 264270552 },
          }),
        ),
        http.delete(`${API}/requested_reviewers`, async ({ request }) => {
          removed.push(await request.json());
          github.reviewers = github.reviewers.filter(
            (login) => login !== "out",
          );
          return HttpResponse.json({ requested_reviewers: [] });
        }),
        http.get(`${API}/commits`, () => HttpResponse.json([])),
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/:login/permission",
          () => HttpResponse.json({ permission: "write" }),
        ),
        // The branch has no rules, so no check must pass before a merge.
        http.get(
          "https://api.github.com/repos/getsentry/junior/rules/branches/main",
          () => HttpResponse.json([]),
        ),
        http.post("https://api.github.com/graphql", async ({ request }) => {
          const { query } = (await request.json()) as { query: string };
          // The pull request's card, with the reviewers GitHub requests now.
          if (query.includes("PullRequestCards")) {
            return HttpResponse.json({
              data: {
                p0: {
                  pullRequest: cardNode({
                    reviewDecision: null,
                    // More reviewers than the card keeps, so Out is not
                    // among the five that it lists.
                    reviewRequests: {
                      nodes: [
                        "r1",
                        "r2",
                        "r3",
                        "r4",
                        "r5",
                        ...github.reviewers,
                      ].map((login) => ({
                        requestedReviewer: { __typename: "User", login },
                      })),
                    },
                    title: "fix: Check",
                  }),
                },
              },
            });
          }
          return HttpResponse.json({
            data: {
              repository: {
                defaultBranchRef: { name: "main" },
                pullRequest: {
                  autoMergeRequest: null,
                  baseRef: {
                    associatedPullRequests: { totalCount: 0 },
                    refUpdateRule: null,
                  },
                  baseRefName: "main",
                  commits: { nodes: [] },
                  headRefOid: "head-1",
                  isDraft: false,
                  isInMergeQueue: false,
                  mergeStateStatus: "CLEAN",
                  reviewRequests: {
                    nodes: [...github.reviewers, "copilot"].map((login) => ({
                      requestedReviewer: {
                        __typename: login === "copilot" ? "Bot" : "User",
                        login,
                      },
                    })),
                  },
                  reviews: {
                    nodes: [],
                    pageInfo: { hasPreviousPage: false, startCursor: null },
                  },
                  state: "OPEN",
                  timelineItems: { nodes: [] },
                  updatedAt: "2026-07-02T12:00:00Z",
                  title: "fix: Check",
                  url: PULL_URL,
                },
              },
            },
          });
        }),
      );
      const reviewItem = async () => {
        const [item] = await getDb()
          .select({ id: juniorInboxItems.id, status: juniorInboxItems.status })
          .from(juniorInboxItems)
          .where(eq(juniorInboxItems.subjectId, PULL_ID));
        if (!item) return undefined;
        const people = await getDb()
          .select({ email: juniorUsers.primaryEmail })
          .from(juniorInboxItemAssignees)
          .innerJoin(
            juniorUsers,
            eq(juniorUsers.id, juniorInboxItemAssignees.userId),
          )
          .where(eq(juniorInboxItemAssignees.itemId, item.id));
        return { ...item, assignees: people.map((row) => row.email).sort() };
      };

      const body = await openPullRequest();
      await sendGitHubWebhook("pull_request", {
        action: "opened",
        pull_request: pullRequest(body, false, "2026-07-01T12:00:00.000Z"),
      });
      // The only reviewer has no linked account, so the review gets no
      // item. It is never up for grabs.
      await sendGitHubWebhook("pull_request", {
        action: "review_requested",
        pull_request: pullRequest(body, false, "2026-07-01T12:01:00.000Z"),
        requested_reviewer: { login: "nolink" },
      });
      expect(await reviewItem()).toBeUndefined();

      github.reviewers = ["nolink", "out"];
      await sendGitHubWebhook("pull_request", {
        action: "review_requested",
        pull_request: pullRequest(body, false, "2026-07-01T12:02:00.000Z"),
        requested_reviewer: { login: "out" },
      });
      const item = await reviewItem();
      expect(item).toMatchObject({
        assignees: ["out@example.com"],
        status: "open",
      });

      // Out sees the item and the pull request, but not the private
      // Conversation. A live read, such as the Inbox tools make, keeps the
      // card, and the page reads only the caches.
      const viewer = await signedInViewer("out@example.com");
      await readLiveCards(viewer, [PULL_URL]);
      const api = new Hono<JuniorApiEnv>();
      api.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      api.route("/", createJuniorApi());
      const listed = (await (
        await api.request("http://localhost/api/inbox-items?for=viewer")
      ).json()) as { items: InboxItemPayload[] };
      const card = listed.items.find(
        (listedItem) => listedItem.id === item!.id,
      );
      expect(card).toMatchObject({
        canAct: true,
        conversationIds: [],
        subject: {
          // Dismiss says that it also removes Out from the reviewers.
          dismissNote: "Also removes you from the reviewers on GitHub.",
          kind: "github:pull_request",
          url: PULL_URL,
        },
      });
      // No root tells the dashboard that the viewer cannot see it.
      expect(card).not.toHaveProperty("rootConversationId");

      const dismissed = await api.request(
        `http://localhost/api/inbox-items/${item!.id}/actions`,
        {
          body: JSON.stringify({ action: "dismiss" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(dismissed.status).toBe(200);
      expect(removed).toEqual([{ reviewers: ["out"] }]);
      expect(await reviewItem()).toMatchObject({ status: "dismissed" });
      // A later webhook's next-action read keeps the App on the card.
      await sendGitHubWebhook("pull_request", {
        action: "review_request_removed",
        pull_request: pullRequest(body, false, "2026-07-01T12:03:00.000Z"),
        requested_reviewer: { login: "out" },
      });
      const { object } = (await readLiveCards(viewer, [PULL_URL])).objects[0]!;
      expect(object.facts).toMatchObject({ reviewers: ["nolink", "copilot"] });
    } finally {
      await fixture.close();
    }
  });
});
