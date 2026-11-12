import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { appendConversationBrief } from "@/chat/briefs/store";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
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
    )(CONVERSATION_URL);
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

    // Not a participant: no card, so the response does not show that the
    // Conversation exists, and the private Brief stays hidden.
    const outsider = await (
      await viewerApi("bob@example.com")
    )(CONVERSATION_URL);
    expect(outsider.objects.size).toBe(0);
    expect(outsider.body).not.toContain("private launch");
  });

  it("resolves a person link and a mailto link to a known person", async () => {
    await linkSlackUser("alice@example.com", "UALICE");
    const personUrl = `${DASHBOARD}/people/${encodeURIComponent("alice@example.com")}`;

    const { objects } = await (
      await viewerApi("bob@example.com")
    )(
      personUrl,
      "mailto:Alice@Example.com",
      "mailto:nobody@example.com",
      "https://example.com/unknown",
    );
    const person = {
      facts: { email: "alice@example.com", type: "person" },
      label: "alice",
      objectType: "person",
      plugin: "junior",
      url: personUrl,
    };
    expect(objects.get(personUrl)).toMatchObject(person);
    expect(objects.get("mailto:Alice@Example.com")).toMatchObject(person);
    expect([...objects.keys()]).toEqual([
      personUrl,
      "mailto:Alice@Example.com",
    ]);
  });
});
