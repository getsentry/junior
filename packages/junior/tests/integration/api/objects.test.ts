import { http, HttpResponse } from "msw";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createApp, defineJuniorPlugins } from "@/app";
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
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  sendGitHubWebhook,
  stubGitHubApp,
  viewerApi,
} from "../../fixtures/github-objects";
import {
  conversationsInfoOk,
  conversationsMembersPage,
  conversationsRepliesPage,
  slackError,
  usersInfoOk,
} from "../../fixtures/slack/factories/api";
import { createPluginTaskQueueTestAdapter } from "../../fixtures/plugin-task-queue";
import { linkSlackUser } from "../../fixtures/slack-user";
import { queueSlackApiResponse } from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const DASHBOARD = "https://junior.example.com";
const CONVERSATION_ID = "slack:CPRIVATE:1712345.0001";
const CONVERSATION_URL = `${DASHBOARD}/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
const PRIVATE_SUMMARY = "The private launch waits on legal review.";

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
    stubGitHubApp();
    const repo = GITHUB_REPO;
    const api = GITHUB_API;
    const reads: string[] = [];
    const publicPage = (title: string) =>
      new HttpResponse(
        `<!doctype html><html><head><meta property="og:title" content="${title}"></head></html>`,
        { headers: { "content-type": "text/html" } },
      );
    mswServer.use(
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
      await linkGitHubMember();
      const bob = await linkSlackUser("bob@example.com", "UBOB");
      await upsertLinkedIdentity(getSqlExecutor(), bob.id, {
        handle: "outsider",
        kind: "user",
        provider: "github",
        providerSubjectId: "1002",
      });

      const member = await (
        await viewerApi("alice@example.com")
      )(
        `${repo}/issues/12`,
        `${repo}/pull/34/`,
        // A linked `getsentry/junior#34` points at the issue URL.
        `${repo}/issues/34`,
        `${repo}/issues/99`,
        `${repo}/issues/56`,
      );
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

      // When GitHub fails after the card TTL, the card keeps the last read.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);
      mswServer.use(
        http.get(`${api}/issues/:number`, () =>
          HttpResponse.json({ message: "Server Error" }, { status: 502 }),
        ),
        http.get(`${api}/pulls/34`, () =>
          HttpResponse.json({ message: "Server Error" }, { status: 502 }),
        ),
      );
      const outage = await (
        await viewerApi("alice@example.com")
      )(`${repo}/issues/12`, `${repo}/pull/34`);
      expect(outage.objects.get(`${repo}/issues/12`)).toMatchObject({
        objectType: "task",
        title: "Show GitHub links as cards",
      });
      expect(outage.objects.get(`${repo}/pull/34`)).toMatchObject({
        objectType: "code_change",
        status: "draft",
        title: "Add GitHub link cards",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows the GitHub object of a webhook on the next card read, with no GitHub call", async () => {
    stubGitHubApp();
    const reads: string[] = [];
    const before = "2026-01-02T03:04:05Z";
    const after = "2026-01-02T04:00:00Z";
    const issue = {
      closed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      html_url: `${GITHUB_REPO}/issues/12`,
      id: 12_000,
      number: 12,
      state: "open",
      title: "Show GitHub links as cards",
      updated_at: before,
      user: { login: "byk" },
    };
    const pullRequest = (number: number) => ({
      additions: 120,
      base: { ref: "main" },
      changed_files: 4,
      closed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      deletions: 8,
      draft: true,
      head: { ref: "feat/github-link-cards", sha: "aaa111" },
      html_url: `${GITHUB_REPO}/pull/${number}`,
      id: number * 1000,
      mergeable: false,
      merged: false,
      merged_at: null,
      number,
      state: "open",
      title: "Add GitHub link cards",
      updated_at: before,
      user: { login: "byk" },
    });
    const deleted = {
      ...issue,
      html_url: `${GITHUB_REPO}/issues/13`,
      id: 13_000,
      number: 13,
    };
    const moving = {
      ...issue,
      html_url: `${GITHUB_REPO}/issues/14`,
      id: 14_000,
      number: 14,
      title: "Move this issue",
    };
    let moved = false;
    mswServer.use(
      http.get(`${GITHUB_API}/issues/14`, () => {
        reads.push("issues/14");
        return moved
          ? new HttpResponse(null, {
              headers: {
                location: "https://api.github.com/repositories/2002/issues/9",
              },
              status: 301,
            })
          : HttpResponse.json(moving);
      }),
      // The moved issue, in a repository that the viewer can also see.
      http.get("https://api.github.com/repositories/2002/issues/9", () =>
        HttpResponse.json({
          ...moving,
          html_url: "https://github.com/getsentry/relay/issues/9",
          number: 9,
          updated_at: after,
        }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/relay/collaborators/:login/permission",
        ({ params }) =>
          HttpResponse.json({
            permission: params["login"] === "alice_acme" ? "read" : "none",
          }),
      ),
      http.get(`${GITHUB_API}/issues/12`, () => {
        reads.push("issues/12");
        return HttpResponse.json(issue);
      }),
      http.get(`${GITHUB_API}/issues/13`, () => {
        reads.push("issues/13");
        return HttpResponse.json(deleted);
      }),
      http.get(
        `${GITHUB_REPO}/issues/13`,
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(`${GITHUB_API}/pulls/:number`, ({ params }) => {
        reads.push(`pulls/${params["number"]}`);
        return ["34", "56", "90"].includes(String(params["number"]))
          ? HttpResponse.json(pullRequest(Number(params["number"])))
          : HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );
    try {
      const tasks = createPluginTaskQueueTestAdapter();
      const app = await createGitHubApp(tasks);
      setDashboardConversationLinkOptions({ baseURL: DASHBOARD });
      await linkGitHubMember();
      const read = await viewerApi("alice@example.com");
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      const first = await read(
        `${GITHUB_REPO}/issues/12`,
        `${GITHUB_REPO}/issues/13`,
        `${GITHUB_REPO}/issues/14`,
        `${GITHUB_REPO}/pull/34`,
        `${GITHUB_REPO}/pull/56`,
        `${GITHUB_REPO}/pull/90`,
      );
      expect(first.objects.get(`${GITHUB_REPO}/issues/13`)).toMatchObject({
        status: "open",
      });
      expect(first.objects.get(`${GITHUB_REPO}/pull/34`)).toMatchObject({
        facts: { additions: 120, mergeable: false },
        status: "draft",
      });

      vi.setSystemTime(start + 50_000);
      await sendGitHubWebhook(app, "issues", {
        action: "closed",
        issue: {
          ...issue,
          closed_at: after,
          state: "closed",
          updated_at: after,
        },
      });
      await sendGitHubWebhook(app, "issues", {
        action: "deleted",
        issue: deleted,
      });
      // A delivery from before the delete comes late.
      await sendGitHubWebhook(app, "issues", {
        action: "edited",
        changes: { title: { from: "Show links" } },
        issue: deleted,
      });
      moved = true;
      await sendGitHubWebhook(app, "issues", {
        action: "transferred",
        issue: { ...moving, updated_at: after },
      });
      // A push marks the pull request ready. The payload leaves out the
      // size and the merge state.
      const { additions: _, mergeable: __, ...pushed } = pullRequest(34);
      await sendGitHubWebhook(app, "pull_request", {
        action: "synchronize",
        pull_request: {
          ...pushed,
          draft: false,
          head: { ref: "feat/github-link-cards", sha: "bbb222" },
          updated_at: after,
        },
      });
      // A delivery from before the push comes late.
      await sendGitHubWebhook(app, "pull_request", {
        action: "edited",
        changes: { title: { from: "Add link cards" } },
        pull_request: { ...pullRequest(34), title: "Older title" },
      });
      // A label on the same head commit. The payload has a null merge
      // state, but nothing that GitHub computes changed.
      await sendGitHubWebhook(app, "pull_request", {
        action: "labeled",
        pull_request: {
          ...pullRequest(56),
          mergeable: null,
          updated_at: after,
        },
      });
      // A new base on the same head commit. The merge state is about the
      // old base.
      await sendGitHubWebhook(app, "pull_request", {
        action: "edited",
        changes: { base: { ref: { from: "main" } } },
        pull_request: {
          ...pullRequest(90),
          base: { ref: "release" },
          mergeable: null,
          updated_at: after,
        },
      });
      // No card has read #78 yet.
      await sendGitHubWebhook(app, "pull_request", {
        action: "opened",
        pull_request: { ...pullRequest(78), title: "Cache GitHub objects" },
      });

      // Past the TTL of the first read, but each webhook started it again.
      vi.setSystemTime(start + 100_000);
      const readsBefore = reads.length;
      const next = await read(
        `${GITHUB_REPO}/issues/12`,
        `${GITHUB_REPO}/issues/13`,
        `${GITHUB_REPO}/issues/14`,
        `${GITHUB_REPO}/pull/34`,
        `${GITHUB_REPO}/pull/56`,
        `${GITHUB_REPO}/pull/78`,
        `${GITHUB_REPO}/pull/90`,
      );
      // Only the moved issue is read again.
      expect(reads.slice(readsBefore)).toEqual(["issues/14"]);
      expect(next.objects.get(`${GITHUB_REPO}/issues/12`)).toMatchObject({
        status: "closed",
      });
      // The deleted issue has no card.
      expect(next.objects.has(`${GITHUB_REPO}/issues/13`)).toBe(false);
      // The moved issue shows where GitHub redirects it.
      expect(next.objects.get(`${GITHUB_REPO}/issues/14`)).toMatchObject({
        title: "Move this issue",
        url: "https://github.com/getsentry/relay/issues/9",
      });
      const pull = next.objects.get(`${GITHUB_REPO}/pull/34`);
      expect(pull).toMatchObject({
        // A field that the payload leaves out stays as cached.
        facts: { additions: 120, deletions: 8 },
        status: "open",
        title: "Add GitHub link cards",
      });
      // The merge state and checks were about the old head commit.
      expect(pull?.facts).toMatchObject({
        checks: "pending",
        mergeable: "pending",
      });
      // A null merge state on the same head and base is a missing field,
      // so the known one stays.
      expect(next.objects.get(`${GITHUB_REPO}/pull/56`)).toMatchObject({
        facts: { mergeable: false },
      });
      // A merge state that was about the old base turns pending.
      expect(next.objects.get(`${GITHUB_REPO}/pull/90`)).toMatchObject({
        facts: { mergeable: "pending" },
      });
      expect(next.objects.get(`${GITHUB_REPO}/pull/78`)).toMatchObject({
        status: "draft",
        title: "Cache GitHub objects",
      });
      // The push and the new base each start a patch of their pull request.
      expect(
        tasks
          .sent()
          .map(({ message }) => ("payload" in message ? message.payload : {})),
      ).toEqual([
        { key: "pulls:getsentry/junior#34", sha: "bbb222" },
        { key: "pulls:getsentry/junior#90", sha: "aaa111" },
      ]);
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
