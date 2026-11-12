import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
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

const DASHBOARD = "https://junior.example.com";
const CONVERSATION_ID = "slack:CPRIVATE:1712345.0001";
const CONVERSATION_URL = `${DASHBOARD}/conversations/${encodeURIComponent(CONVERSATION_ID)}`;
const PRIVATE_BRIEF = "The private launch waits on legal review.";

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
  await appendConversationBrief(getDb(), {
    conversationId: CONVERSATION_ID,
    turnId: "brief-turn",
    throughSeq: 0,
    content: conversationBriefFixture({ summary: PRIVATE_BRIEF }),
    searchText: PRIVATE_BRIEF,
    modelId: "test-model",
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
    await closeDb();
  });

  it("resolves a private Conversation only for its participants", async () => {
    await recordPrivateConversation();

    const participant = await (
      await viewerApi("alice@example.com")
    )(CONVERSATION_URL, `${CONVERSATION_URL}/`);
    expect(participant.objects.get(CONVERSATION_URL)).toMatchObject({
      description: PRIVATE_BRIEF,
      facts: {
        lastActivityAt: "2026-01-02T03:04:05.000Z",
        participants: ["Alice Example"],
        type: "conversation",
      },
      kind: "object",
      label: "Plan the private launch",
      objectType: "conversation",
      plugin: "junior",
      status: "idle",
      title: "Plan the private launch",
      url: CONVERSATION_URL,
    });
    // A trailing slash names the same Conversation.
    expect(participant.objects.get(`${CONVERSATION_URL}/`)).toMatchObject({
      url: CONVERSATION_URL,
    });

    // Not a participant: no card, so the response does not show that the
    // Conversation exists, and the private Brief stays hidden.
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
    const personUrl = `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`;
    const unlinkedUrl = `${DASHBOARD}/people/${encodeURIComponent("carol@example.com")}`;

    const { objects } = await (
      await viewerApi("bob@example.com")
    )(
      personUrl,
      "mailto:Alice@Example.com",
      "mailto:nobody@example.com",
      "https://example.com/unknown",
      unlinkedUrl,
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
    expect([...objects.keys()]).toEqual([
      personUrl,
      "mailto:Alice@Example.com",
      unlinkedUrl,
    ]);
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
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({ channelId: "C0PUBLIC", name: "proj-launch" }),
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

    // No linked Slack account, or a link to another workspace: no card.
    const unlinked = await (await viewerApi("carol@example.com"))(publicUrl);
    expect(unlinked.objects.size).toBe(0);
    const otherWorkspace = (
      await alice(publicUrl.replace("example.", "other."))
    ).objects;
    expect(otherWorkspace.size).toBe(0);
  });
});
