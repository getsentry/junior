import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  actorProfileReportSchema,
  conversationFeedSchema,
  leadSchema,
} from "@/api/schema";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { closeConversationFixture } from "../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../fixtures/conversation-work";
import { signedInViewer } from "../../fixtures/user";

const queue = createConversationWorkQueueTestAdapter();

function apiFor(email?: string): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    if (email) context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: queue }));
  return app;
}

async function readLeadId(app: Hono<JuniorApiEnv>): Promise<string> {
  const response = await app.request("http://localhost/api/lead");
  expect(response.status).toBe(200);
  return leadSchema.parse(await response.json()).conversationId;
}

async function postMessage(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  idempotencyKey: string,
): Promise<Response> {
  return await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      body: JSON.stringify({ idempotencyKey, message: "Check the deploy." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}

describe("Lead API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("returns the same Lead for its person, and takes only their messages", async () => {
    const ana = apiFor("lead-api-ana@example.com");
    const bo = apiFor("lead-api-bo@example.com");

    expect((await apiFor().request("http://localhost/api/lead")).status).toBe(
      401,
    );
    const leadId = await readLeadId(ana);
    expect(await readLeadId(ana)).toBe(leadId);
    expect(await readLeadId(bo)).not.toBe(leadId);

    const sent = await postMessage(ana, leadId, "lead-api-ana-message");
    expect(sent.status).toBe(200);
    expect(
      acceptedConversationMessageSchema.parse(await sent.json()),
    ).toMatchObject({ conversationId: leadId, status: "accepted" });
    expect((await postMessage(bo, leadId, "lead-api-bo-message")).status).toBe(
      403,
    );
  });

  it("keeps the Lead out of the conversation lists of its person", async () => {
    const email = "lead-api-lists@example.com";
    const api = apiFor(email);
    const viewer = await signedInViewer(email);
    const leadId = await readLeadId(api);
    expect((await postMessage(api, leadId, "lead-api-lists")).status).toBe(200);
    // What a finished Run of the Lead writes, so the person's profile would
    // count it as a Conversation of theirs.
    const nowMs = Date.now();
    await getConversationStore().recordExecution({
      actorIdentityId: await resolveActorIdentityId(
        getSqlExecutor(),
        webActorFromUser(viewer),
      ),
      conversationId: leadId,
      createdAtMs: nowMs,
      execution: { runId: `${leadId}:turn`, status: "idle" },
      lastActivityAtMs: nowMs,
      metrics: { durationMs: 100, usage: { totalTokens: 1 } },
      updatedAtMs: nowMs,
    });
    const work = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(viewer),
        idempotencyKey: "lead-api-lists-work",
        message: "Draft the release notes.",
      },
      { queue },
    );

    const feedIds = async (query: string) =>
      conversationFeedSchema
        .parse(
          await (
            await api.request(`http://localhost/api/conversations${query}`)
          ).json(),
        )
        .conversations.map((conversation) => conversation.conversationId);
    expect(await feedIds("")).toEqual([work.conversationId]);
    // The Lead's title is "Lead", so a search for it would match.
    expect(await feedIds("?q=Lead")).toEqual([]);

    const profile = actorProfileReportSchema.parse(
      await (
        await api.request(
          `http://localhost/api/people/${encodeURIComponent(email)}`,
        )
      ).json(),
    );
    expect(
      profile.recentConversations.map((item) => item.conversationId),
    ).not.toContain(leadId);
  });
});
