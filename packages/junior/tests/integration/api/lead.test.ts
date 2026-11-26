import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { createAcpConversations } from "@/api/acp/conversations";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  actorProfileReportSchema,
  conversationDetailReportSchema,
  conversationFeedSchema,
  leadSchema,
  spaceSchema,
} from "@/api/schema";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { getStateAdapter } from "@/chat/state/adapter";
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

async function createSpace(
  app: Hono<JuniorApiEnv>,
  name: string,
): Promise<string> {
  const response = await app.request("http://localhost/api/spaces", {
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(201);
  return spaceSchema.parse(await response.json()).id;
}

function leadPath(spaceId: string): string {
  return `http://localhost/api/spaces/${encodeURIComponent(spaceId)}/lead`;
}

async function readLeadId(
  app: Hono<JuniorApiEnv>,
  spaceId: string,
): Promise<string> {
  const response = await app.request(leadPath(spaceId));
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

  it("returns one Lead for each Space, and takes messages only from members", async () => {
    const ana = apiFor("lead-api-ana@example.com");
    const bo = apiFor("lead-api-bo@example.com");
    const spaceId = await createSpace(ana, "Billing migration");

    expect((await apiFor().request(leadPath(spaceId))).status).toBe(401);
    const leadId = await readLeadId(ana, spaceId);
    expect(await readLeadId(ana, spaceId)).toBe(leadId);
    // The Lead is public like the Space, so anyone reads the same one.
    expect(await readLeadId(bo, spaceId)).toBe(leadId);
    expect(
      await readLeadId(ana, await createSpace(ana, "Mobile app")),
    ).not.toBe(leadId);

    // A rename renames the Lead too.
    const renamed = await ana.request(
      `http://localhost/api/spaces/${encodeURIComponent(spaceId)}`,
      {
        body: JSON.stringify({ name: "Billing cutover" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(renamed.status).toBe(200);
    const leadDetail = await ana.request(
      `http://localhost/api/conversations/${encodeURIComponent(leadId)}`,
    );
    expect(
      conversationDetailReportSchema.parse(await leadDetail.json())
        .displayTitle,
    ).toBe("Billing cutover");

    const sent = await postMessage(ana, leadId, "lead-api-ana-message");
    expect(sent.status).toBe(200);
    expect(
      acceptedConversationMessageSchema.parse(await sent.json()),
    ).toMatchObject({ conversationId: leadId, status: "accepted" });
    expect((await postMessage(bo, leadId, "lead-api-bo-message")).status).toBe(
      403,
    );
    const joined = await bo.request(
      `http://localhost/api/spaces/${encodeURIComponent(spaceId)}/members/me`,
      { method: "PUT" },
    );
    expect(joined.status).toBe(200);
    expect((await postMessage(bo, leadId, "lead-api-bo-joined")).status).toBe(
      200,
    );

    // Leaving ends Ana's part in the Lead, so no surface takes her messages.
    const left = await ana.request(
      `http://localhost/api/spaces/${encodeURIComponent(spaceId)}/members/me`,
      { method: "DELETE" },
    );
    expect(left.status).toBe(200);
    expect((await postMessage(ana, leadId, "lead-api-ana-left")).status).toBe(
      403,
    );
    const state = getStateAdapter();
    await state.connect();
    await expect(
      createAcpConversations({
        eventStore: getConversationEventStore(),
        queue,
        state,
      }).prompt({
        conversationId: leadId,
        idempotencyKey: "lead-api-ana-acp",
        text: "Check the deploy.",
        user: await signedInViewer("lead-api-ana@example.com"),
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("keeps the Lead out of the conversation lists", async () => {
    const email = "lead-api-lists@example.com";
    const api = apiFor(email);
    const viewer = await signedInViewer(email);
    const spaceId = await createSpace(api, "Release notes");
    const leadId = await readLeadId(api, spaceId);
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
    expect(await feedIds(`?spaceId=${spaceId}`)).toEqual([]);
    // The Lead's title is the Space's name, so a search for it would match.
    expect(await feedIds("?q=Release")).toEqual([]);

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
