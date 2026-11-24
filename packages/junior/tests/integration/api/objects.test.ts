import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { resolveObjectLinkNow } from "@/api/objects/resolve";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import {
  deleteProviderIdentityForUser,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { juniorIdentities } from "@/db/schema";
import { storeConversationMetadataFixture } from "../../fixtures/conversation-metadata";
import {
  conversationsInfoOk,
  conversationsMembersPage,
  conversationsRepliesPage,
  slackError,
  usersInfoOk,
} from "../../fixtures/slack/factories/api";
import { linkSlackUser } from "../../fixtures/slack-user";
import { signedInViewer } from "../../fixtures/user";
import { queueSlackApiResponse } from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const CONVERSATION_ID = "slack:CPRIVATE:1712345.0001";
const CONVERSATION_URL = `${DASHBOARD}/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
const PRIVATE_SUMMARY = "The private launch waits on legal review.";

async function viewerApi(email: string) {
  const viewer = await signedInViewer(email);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (...urls: string[]) => {
    const query = new URLSearchParams(urls.map((url) => ["url", url]));
    const response = await app.request(`http://localhost/api/objects?${query}`);
    expect(response.status).toBe(200);
    // The browser may keep a card as long as the server cache does.
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("vary")).toBe("Authorization, Cookie");
    const body = await response.text();
    return {
      body,
      objects: new Map(
        objectLinksReportSchema
          .parse(JSON.parse(body))
          .objects.map((item) => [item.url, item.object]),
      ),
    };
  };
}

async function recordPrivateConversation() {
  await getConversationStore().recordActivity({
    actor: {
      email: "alice@example.com",
      fullName: "Alice Example",
      platform: "slack",
      slackUserId: "UALICE",
      teamId: "T123",
    },
    conversationId: CONVERSATION_ID,
    destination: { channelId: "CPRIVATE", platform: "slack", teamId: "T123" },
    nowMs: Date.parse("2026-01-02T03:04:05.000Z"),
    source: "slack",
    title: "Plan the private launch",
    visibility: "private",
  });
  await storeConversationMetadataFixture(getDb(), {
    conversationId: CONVERSATION_ID,
    summary: PRIVATE_SUMMARY,
  });
}

describe("object links API", () => {
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

  it("resolves a private Conversation only for its participants", async () => {
    await recordPrivateConversation();

    const participant = await (
      await viewerApi("alice@example.com")
    )(CONVERSATION_URL, `${CONVERSATION_URL}/`);
    expect(participant.objects.get(CONVERSATION_URL)).toMatchObject({
      description: PRIVATE_SUMMARY,
      facts: {
        lastActivityAt: "2026-01-02T03:04:05.000Z",
        participants: ["Alice Example"],
        type: "conversation",
      },
      kind: "object",
      label: "Plan the private launch",
      objectType: "conversation",
      plugin: "junior",
      status: "done",
      title: "Plan the private launch",
      url: CONVERSATION_URL,
    });
    // A trailing slash names the same Conversation.
    expect(participant.objects.get(`${CONVERSATION_URL}/`)).toMatchObject({
      url: CONVERSATION_URL,
    });

    // Not a participant: no card, so the response does not show that the
    // Conversation exists, and the private summary stays hidden.
    const outsider = await (
      await viewerApi("bob@example.com")
    )(CONVERSATION_URL);
    expect(outsider.objects.size).toBe(0);
    expect(outsider.body).not.toContain("private launch");
  });

  it("resolves a person link and a mailto link to a known person", async () => {
    const alice = await linkSlackUser("alice@example.com", "UALICE");
    await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
      handle: "alice_acme",
      kind: "user",
      provider: "github",
      providerSubjectId: "1001",
    });
    await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
      avatarUrl: "https://lh3.googleusercontent.com/a/alice",
      kind: "user",
      provider: "google",
      providerSubjectId: "g-alice",
    });
    await linkSlackUser("carol@example.com", "UCAROL");
    // No Slack Identity and no User name: another Identity names the person.
    const dave = await resolveViewerUserFromSql(getDb(), "dave@example.com");
    await upsertLinkedIdentity(getSqlExecutor(), dave!.id, {
      displayName: "Dave Example",
      kind: "user",
      provider: "google",
      providerSubjectId: "g-dave",
    });
    const daveUrl = `${DASHBOARD}/people/${encodeURIComponent("dave@example.com")}`;
    const personUrl = `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`;
    const unlinkedUrl = `${DASHBOARD}/people/${encodeURIComponent("carol@example.com")}`;

    const { objects } = await (
      await viewerApi("bob@example.com")
    )(
      personUrl,
      "mailto:Alice@Example.com",
      "mailto:nobody@example.com",
      // Other dashboard pages get no card and no fetch.
      `${DASHBOARD}/automations`,
      unlinkedUrl,
      daveUrl,
    );
    const person = {
      facts: {
        email: "alice@example.com",
        avatarUrl: expect.stringMatching(/^\/api\/people\/avatars\//),
        githubHandle: "alice_acme",
        type: "person",
      },
      label: "alice",
      objectType: "person",
      plugin: "junior",
      url: personUrl,
    };
    expect(objects.get(personUrl)).toMatchObject(person);
    expect(objects.get("mailto:Alice@Example.com")).toMatchObject(person);
    expect(objects.get(unlinkedUrl)?.facts).toEqual({
      email: "carol@example.com",
      type: "person",
    });
    expect(objects.get(daveUrl)).toMatchObject({ label: "Dave Example" });
    expect([...objects.keys()]).toEqual([
      personUrl,
      "mailto:Alice@Example.com",
      unlinkedUrl,
      daveUrl,
    ]);
  });

  it("resolves GitHub profile links to known people and GitHub accounts", async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    // App setup reads the dashboard URL from the environment.
    setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
    const alice = await linkSlackUser("alice@example.com", "UALICE");
    await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
      handle: "alice_acme",
      kind: "user",
      provider: "github",
      providerSubjectId: "1001",
    });

    const { objects } = await (
      await viewerApi("bob@example.com")
    )(
      "https://github.com/Alice_Acme",
      "https://github.com/octocat",
      "https://github.com/features",
    );
    expect(objects.get("https://github.com/Alice_Acme")).toMatchObject({
      facts: { email: "alice@example.com", githubHandle: "alice_acme" },
      objectType: "person",
      plugin: "github",
      url: `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`,
    });
    expect(objects.get("https://github.com/octocat")).toMatchObject({
      displayType: "GitHub account",
      facts: { githubHandle: "octocat", type: "person" },
      label: "@octocat",
      objectType: "person",
      url: "https://github.com/octocat",
    });
    expect(objects.has("https://github.com/features")).toBe(false);
  });

  it("resolves GitHub issue and pull request links for viewers who can see the repository", async () => {
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs1" })
        .toString(),
    );
    const repo = "https://github.com/getsentry/junior";
    const api = "https://api.github.com/repos/getsentry/junior";
    const reads: string[] = [];
    const publicPage = (title: string) =>
      new HttpResponse(
        `<!doctype html><html><head><meta property="og:title" content="${title}"></head></html>`,
        { headers: { "content-type": "text/html" } },
      );
    mswServer.use(
      http.get("https://api.github.com/app/installations/456", () =>
        HttpResponse.json({
          permissions: {
            issues: "read",
            metadata: "read",
            pull_requests: "read",
          },
        }),
      ),
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            token: "app-token",
          }),
      ),
      http.get(`${api}/collaborators/:login/permission`, ({ params }) =>
        HttpResponse.json({
          permission: params["login"] === "alice_acme" ? "read" : "none",
        }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/secret/collaborators/:login/permission",
        () => HttpResponse.json({ permission: "none" }),
      ),
      // A transferred issue redirects to its new repository.
      http.get("https://api.github.com/repositories/999/issues/56", () =>
        HttpResponse.json({
          body: "Secret plans.",
          html_url: "https://github.com/getsentry/secret/issues/56",
          number: 56,
          state: "open",
          title: "Secret transferred issue",
        }),
      ),
      http.get(`${api}/issues/:number`, ({ params }) => {
        reads.push(`issues/${params["number"]}`);
        if (params["number"] === "12") {
          return HttpResponse.json({
            assignees: [{ login: "alice_acme" }],
            body: "Pasted links show as plain links.",
            html_url: `${repo}/issues/12`,
            labels: [{ name: "bug" }],
            number: 12,
            state: "open",
            title: "Show GitHub links as cards",
            updated_at: "2026-01-02T03:04:05Z",
            user: { login: "byk" },
          });
        }
        if (params["number"] === "56") {
          return new HttpResponse(null, {
            headers: {
              location: "https://api.github.com/repositories/999/issues/56",
            },
            status: 301,
          });
        }
        if (params["number"] === "34") {
          return HttpResponse.json({
            html_url: `${repo}/pull/34`,
            number: 34,
            pull_request: { url: `${api}/pulls/34` },
            state: "open",
            title: "Add GitHub link cards",
          });
        }
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }),
      http.get(`${api}/pulls/12`, () => {
        reads.push("pulls/12");
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }),
      http.get(`${api}/pulls/34`, () => {
        reads.push("pulls/34");
        return HttpResponse.json({
          additions: 120,
          base: { ref: "main" },
          changed_files: 4,
          deletions: 8,
          draft: true,
          head: { ref: "feat/github-link-cards" },
          html_url: `${repo}/pull/34`,
          mergeable: false,
          merged: false,
          number: 34,
          state: "open",
          title: "Add GitHub link cards",
          user: { login: "byk" },
        });
      }),
      // A page of links reads its objects with one GraphQL query. A
      // transferred issue is null there, so its REST read follows the move.
      http.post("https://api.github.com/graphql", async ({ request }) => {
        reads.push("graphql");
        const { variables } = (await request.json()) as {
          variables: Record<string, number | string>;
        };
        const pull = {
          __typename: "PullRequest",
          additions: 120,
          author: { login: "byk" },
          baseRefName: "main",
          body: null,
          changedFiles: 4,
          deletions: 8,
          headRefName: "feat/github-link-cards",
          isDraft: true,
          mergeable: "CONFLICTING",
          merged: false,
          number: 34,
          reviewDecision: "APPROVED",
          reviewRequests: { nodes: [] },
          state: "OPEN",
          title: "Add GitHub link cards",
          updatedAt: "2026-01-02T03:04:05Z",
          url: `${repo}/pull/34`,
        };
        const objects: Record<number, unknown> = {
          12: {
            __typename: "Issue",
            assignees: { nodes: [{ login: "alice_acme" }] },
            body: "Pasted links show as plain links.",
            labels: { nodes: [{ name: "bug" }] },
            number: 12,
            issueState: "OPEN",
            title: "Show GitHub links as cards",
            updatedAt: "2026-01-02T03:04:05Z",
            url: `${repo}/issues/12`,
          },
          34: pull,
        };
        return HttpResponse.json({
          data: {
            r0: {
              releaseConfig: null,
              ...Object.fromEntries(
                Object.entries(variables)
                  .filter(([name]) => name.startsWith("n0_"))
                  .map(([name, number]) => [
                    name,
                    objects[Number(number)] ?? null,
                  ]),
              ),
            },
          },
        });
      }),
      // What GitHub shows signed out.
      http.get(
        `${repo}/issues/12`,
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        `${repo}/issues/56`,
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(`${repo}/issues/34`, () => publicPage("Public pull request")),
      http.get(`${repo}/pull/34`, () => publicPage("Public pull request")),
    );
    try {
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
      const alice = await linkSlackUser("alice@example.com", "UALICE");
      await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
        handle: "alice_acme",
        kind: "user",
        provider: "github",
        providerSubjectId: "1001",
      });
      const bob = await linkSlackUser("bob@example.com", "UBOB");
      await upsertLinkedIdentity(getSqlExecutor(), bob.id, {
        handle: "outsider",
        kind: "user",
        provider: "github",
        providerSubjectId: "1002",
      });

      // A single-link read, such as Attach, caches the REST card first. It
      // has no review decision, so the page's GraphQL read replaces it.
      const viewer = await signedInViewer("alice@example.com");
      const single = await resolveObjectLinkNow(
        viewer,
        new URL(`${repo}/pull/34`),
      );
      expect(single?.object.facts).toMatchObject({ type: "code_change" });
      expect(
        (single?.object.facts as { review?: string } | undefined)?.review,
      ).toBeUndefined();
      reads.length = 0;
      const member = await (
        await viewerApi("alice@example.com")
      )(
        `${repo}/issues/12`,
        `${repo}/pull/34/`,
        // A linked `getsentry/junior#34` points at the issue URL.
        `${repo}/issues/34`,
        `${repo}/issues/99`,
        `${repo}/issues/56`,
        // GraphQL reads the issue for a pull link to an issue number.
        `${repo}/pull/12`,
      );
      // One query reads the page. Only the objects that it misses, such as
      // a transferred issue, are read one at a time.
      expect(reads.filter((read) => read === "graphql")).toHaveLength(1);
      expect(reads).not.toContain("issues/12");
      expect(reads).not.toContain("pulls/34");
      expect(member.objects.get(`${repo}/issues/12`)).toMatchObject({
        description: "Pasted links show as plain links.",
        displayType: "Issue",
        facts: { assignees: ["alice_acme"], labels: ["bug"], type: "task" },
        key: "getsentry/junior#12",
        label: "getsentry/junior#12",
        objectType: "task",
        plugin: "github",
        status: "open",
        title: "Show GitHub links as cards",
        url: `${repo}/issues/12`,
      });
      expect(member.objects.get(`${repo}/pull/34/`)).toMatchObject({
        displayType: "Pull request",
        facts: {
          additions: 120,
          author: "byk",
          // The live merge state: the Inbox says "Merge conflict".
          mergeable: false,
          review: "approved",
          sourceBranch: "feat/github-link-cards",
          targetBranch: "main",
          type: "code_change",
        },
        label: "getsentry/junior#34",
        objectType: "code_change",
        status: "draft",
        url: `${repo}/pull/34`,
      });
      // GitHub opens a pull request at its issue URL too, so the card is the
      // pull request card.
      expect(member.objects.get(`${repo}/issues/34`)).toMatchObject({
        label: "getsentry/junior#34",
        objectType: "code_change",
        plugin: "github",
        status: "draft",
        url: `${repo}/pull/34`,
      });
      expect(member.objects.has(`${repo}/issues/99`)).toBe(false);
      // The issue card is not cached for the pull link, so the pulls API
      // answers that there is no such pull request.
      expect(reads).toContain("pulls/12");
      expect(member.objects.has(`${repo}/pull/12`)).toBe(false);
      // A transferred issue shows only when the viewer can see its new
      // repository.
      expect(member.objects.has(`${repo}/issues/56`)).toBe(false);
      expect(member.body).not.toContain("Secret");

      // A viewer who cannot see the repository gets only what GitHub shows
      // signed out, and the App reads nothing more for them.
      const readsBefore = reads.length;
      const outsider = await (
        await viewerApi("bob@example.com")
      )(`${repo}/issues/12`, `${repo}/pull/34`);
      expect(outsider.objects.has(`${repo}/issues/12`)).toBe(false);
      expect(outsider.objects.get(`${repo}/pull/34`)).toMatchObject({
        objectType: "web_page",
        title: "Public pull request",
      });
      expect(outsider.body).not.toContain("GitHub links as cards");
      expect(reads.slice(readsBefore)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Reads in the first seconds after an Identity write skip the cache.
  function passIdentityWriteWindow() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
  }

  it("serves a person card from the identity cache to every viewer", async () => {
    const alice = await linkSlackUser("alice@example.com", "UALICE");
    await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
      handle: "alice_acme",
      kind: "user",
      provider: "github",
      providerSubjectId: "1001",
    });
    passIdentityWriteWindow();
    const personUrl = `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`;
    const first = await (await viewerApi("bob@example.com"))(personUrl);
    expect(first.objects.get(personUrl)?.facts).toMatchObject({
      githubHandle: "alice_acme",
    });

    // A write outside the Identity writers does not clear the cache, so the
    // next viewer gets the cached person.
    await getDb()
      .update(juniorIdentities)
      .set({ handle: "renamed" })
      .where(eq(juniorIdentities.providerSubjectId, "1001"));
    const second = await (await viewerApi("carol@example.com"))(personUrl);
    expect(second.objects.get(personUrl)?.facts).toMatchObject({
      githubHandle: "alice_acme",
    });
  });

  it("shows a GitHub link and unlink on the person card at once", async () => {
    const alice = await linkSlackUser("alice@example.com", "UALICE");
    passIdentityWriteWindow();
    const personUrl = `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`;
    const resolve = await viewerApi("bob@example.com");
    const handle = async () =>
      (await resolve(personUrl)).objects.get(personUrl)?.facts;
    expect(await handle()).not.toHaveProperty("githubHandle");

    await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
      handle: "alice_acme",
      kind: "user",
      provider: "github",
      providerSubjectId: "1001",
    });
    expect(await handle()).toMatchObject({ githubHandle: "alice_acme" });

    await deleteProviderIdentityForUser(
      getSqlExecutor(),
      alice.id,
      "github",
      "1001",
    );
    expect(await handle()).not.toHaveProperty("githubHandle");
  });

  it("resolves a Slack message only where the viewer's Slack account sees it", async () => {
    await linkSlackUser("alice@example.com", "UALICE");
    await linkSlackUser("bob@example.com", "UBOB");
    const alice = await viewerApi("alice@example.com");
    const bob = await viewerApi("bob@example.com");
    const publicUrl =
      "https://example.slack.com/archives/C0PUBLIC/p1712345000000100";
    const privateUrl =
      "https://example.slack.com/archives/C0PRIVATE/p1712345000000200?thread_ts=1712345000.000100&cid=C0PRIVATE";

    // Public channel that the bot has not joined: the card has no text.
    const publicInfo = {
      body: conversationsInfoOk({ channelId: "C0PUBLIC", name: "proj-launch" }),
    };
    queueSlackApiResponse("conversations.info", publicInfo);
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "UALICE" }),
    });
    queueSlackApiResponse("conversations.replies", {
      body: slackError({ error: "not_in_channel" }),
    });
    expect((await alice(publicUrl)).objects.get(publicUrl)).toEqual({
      facts: {
        channel: "#proj-launch",
        sentAt: "2024-04-05T19:23:20.000Z",
        type: "message",
      },
      key: "slack:T123:C0PUBLIC:1712345000.000100",
      kind: "object",
      label: "#proj-launch",
      objectType: "message",
      plugin: "junior",
      title: "Message in #proj-launch",
      url: publicUrl,
    });

    // A guest sees a public channel only when they are in it.
    queueSlackApiResponse("conversations.info", publicInfo);
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ isRestricted: true, userId: "UBOB" }),
    });
    queueSlackApiResponse("conversations.members", {
      body: conversationsMembersPage({ members: ["UALICE"] }),
    });
    const guest = await bob(publicUrl);
    expect(guest.objects.size).toBe(0);
    expect(guest.body).not.toContain("proj-launch");

    // A private channel resolves for a member, with a short snippet.
    const privateInfo = {
      body: conversationsInfoOk({
        channelId: "C0PRIVATE",
        isPrivate: true,
        name: "launch-legal",
      }),
    };
    const members = { body: conversationsMembersPage({ members: ["UALICE"] }) };
    queueSlackApiResponse("conversations.info", privateInfo);
    queueSlackApiResponse("conversations.members", members);
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        messages: [
          { text: "Thread root", ts: "1712345000.000100", user: "UAUTHOR" },
          {
            text: "Legal signs off Friday <!here>, see <https://example.com/plan|the plan>",
            thread_ts: "1712345000.000100",
            ts: "1712345000.000200",
            user: "UAUTHOR",
          },
        ],
      }),
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ realName: "Morgan Lee", userId: "UAUTHOR" }),
    });
    expect((await alice(privateUrl)).objects.get(privateUrl)).toMatchObject({
      facts: {
        author: "Morgan Lee",
        channel: "#launch-legal",
        type: "message",
      },
      label: "#launch-legal",
      title: "Legal signs off Friday @here, see the plan",
    });

    // Not a member: no card, and the response does not show the message.
    queueSlackApiResponse("conversations.info", privateInfo);
    queueSlackApiResponse("conversations.members", members);
    const outsider = await bob(privateUrl);
    expect(outsider.objects.size).toBe(0);
    expect(outsider.body).not.toContain("launch-legal");

    // A deleted message: no card.
    queueSlackApiResponse("conversations.info", privateInfo);
    queueSlackApiResponse("conversations.members", members);
    queueSlackApiResponse("conversations.replies", {
      body: slackError({ error: "thread_not_found" }),
    });
    const deletedUrl =
      "https://example.slack.com/archives/C0PRIVATE/p1712345000000300";
    expect((await alice(deletedUrl)).objects.size).toBe(0);

    // A thread that does not have the linked reply: no card.
    queueSlackApiResponse("conversations.info", privateInfo);
    queueSlackApiResponse("conversations.members", members);
    queueSlackApiResponse("conversations.replies", {
      body: conversationsRepliesPage({
        messages: [
          { text: "Thread root", ts: "1712345000.000100", user: "UAUTHOR" },
        ],
      }),
    });
    const missingReplyUrl =
      "https://example.slack.com/archives/C0PRIVATE/p1712345000000400?thread_ts=1712345000.000100";
    expect((await alice(missingReplyUrl)).objects.size).toBe(0);

    // No linked Slack account, or a link to another workspace: no card.
    const unlinked = await (await viewerApi("carol@example.com"))(publicUrl);
    expect(unlinked.objects.size).toBe(0);
    const otherWorkspace = (
      await alice(publicUrl.replace("example.", "other."))
    ).objects;
    expect(otherWorkspace.size).toBe(0);
  });
});
