import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { githubPlugin } from "@sentry/junior-github";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorInboxItems } from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";
import { mswServer } from "../msw/server";

const API = "https://api.github.com/repos/getsentry/junior/pulls/1592";
const PULL_URL = "https://github.com/getsentry/junior/pull/1592";
const BOT = "sentry-junior[bot]";
const person = slackInvocationInput.actor;

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
    id: 1_592_000,
    merged,
    merged_at: merged ? updatedAt : null,
    number: 1592,
    title: "fix: Check",
    updated_at: updatedAt,
    user: { login: BOT },
  };
}

/** What a dashboard reader sees: the chip status and the ask's state. */
async function readerView() {
  const chip = (
    await listConversationAnnotations(getDb(), slackParentConversationId)
  ).find((annotation) => annotation.key === "getsentry/junior#1592");
  const [ask] = await getDb()
    .select({ status: juniorInboxItems.status })
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.subjectId, PULL_URL));
  return { ask: ask?.status, chip: chip?.status };
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

  it("closes before the chip says merged, so no reader sees a merged pull request with an open ask", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const slack = await upsertIdentity(getSqlExecutor(), {
      displayName: "Pat Requester",
      email: "pat@example.com",
      emailVerified: true,
      kind: "user",
      provider: "slack",
      providerSubjectId: person.userId,
      providerTenantId: person.teamId,
    });
    // "Ready to merge" needs the requester's GitHub login, to read whether
    // their repository role can merge.
    await upsertLinkedIdentity(getSqlExecutor(), slack.userId!, {
      handle: "pat",
      kind: "user",
      provider: "github",
      providerSubjectId: "3001",
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
      // The merge webhook calls GitHub between its writes. Each GitHub read
      // during it records what a dashboard reader sees at that moment.
      const views: Array<Awaited<ReturnType<typeof readerView>>> = [];
      const observe = async () => {
        if (github.merged) views.push(await readerView());
      };
      mswServer.use(
        http.get(API, async () => {
          await observe();
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
          await observe();
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
        http.get(
          "https://api.github.com/repos/getsentry/junior/collaborators/pat/permission",
          () => HttpResponse.json({ permission: "write", role_name: "write" }),
        ),
        http.get(`${API}/commits`, async () => {
          await observe();
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
      expect(await readerView()).toEqual({ ask: "open", chip: "open" });

      github.merged = true;
      await sendGitHubWebhook("pull_request", {
        action: "closed",
        pull_request: pullRequest(body, true, "2026-07-03T12:00:00.000Z"),
      });

      expect(views.length).toBeGreaterThan(0);
      expect(views).not.toContainEqual({ ask: "open", chip: "merged" });
      expect(await readerView()).toEqual({ ask: "done", chip: "merged" });
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
});
