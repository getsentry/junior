import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  deleteProviderIdentityForUser,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
import { juniorIdentities } from "@/db/schema";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
import { linkSlackUser } from "../../fixtures/slack-user";
import { signedInViewer } from "../../fixtures/user";

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
    vi.useRealTimers();
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
});
