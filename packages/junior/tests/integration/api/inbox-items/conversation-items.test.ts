import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { conversationQuestionsReportSchema } from "@/api/schema";
import { getConversationStore, getDb } from "@/chat/db";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import type { UserInputRequest } from "@/chat/inbox-items/user-input-request";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { getConversation } from "@/chat/task-execution/store";
import { juniorConversationParticipants } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";
import { measureSql } from "../../../fixtures/sql-budget";

const REQUEST: UserInputRequest = {
  question: "Approve or reject this entry?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
    { id: "reason", kind: "text", label: "Reason" },
  ],
};

/** A person signed in to the dashboard, linked to Slack workspace T123. */
async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return {
    ...resolved,
    identities: [
      {
        id: `identity:slack:${email}`,
        provider: "slack",
        providerSubjectId: `U-${email}`,
        providerTenantId: "T123",
      },
    ],
  };
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return {
    act: (id: string, body: unknown) =>
      app.request(`http://localhost/api/inbox-items/${id}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    get: (path: string) =>
      app.request(`http://localhost/api/inbox-items${path}`),
    questions: (conversationId: string) =>
      app.request(
        `http://localhost/api/conversations/${conversationId}/questions`,
      ),
  };
}

async function pendingMessages(conversationId: string) {
  const conversation = await getConversation({ conversationId });
  return conversation?.execution.pendingMessages ?? [];
}

// Who sees and answers the items of one Conversation on the dashboard.
describe("inbox items of a Conversation", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("shows a Conversation's items to the people in it", async () => {
    const fixture = await createConversationFixture();
    const ana = await user("ana@example.com");
    const cal = await user("cal@example.com");
    await user("ben@example.com");
    // A public dashboard Conversation that Ben started. Ana joined and then
    // unsubscribed, so she is an inactive Participant.
    await getConversationStore().recordActivity({
      actor: { email: "ben@example.com" },
      conversationId: "local:web:shared",
      destination: { platform: "local", conversationId: "local:web:shared" },
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      source: "web",
      visibility: "public",
    });
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1),
        rootConversationId: "local:web:shared",
        unsubscribedAt: new Date(2),
        userId: ana.id,
      });
    // An event Turn asks without naming anyone, so the item goes to the
    // active Participants: only Ben.
    const tool = createAddInboxItemTool(
      {
        conversationId: "local:web:shared",
        resolveActorIdentity: async () => undefined,
        source: { kind: "event" } as any,
      },
      createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
    );
    const { item } = await (tool as any).execute(
      {
        kind: "action",
        title: "Close the tracking issue?",
        body: "The pull request merged.",
        request: REQUEST,
      },
      {},
    );
    const { item: other } = await (tool as any).execute(
      {
        kind: "action",
        title: "Delete the release branch?",
        body: "The release shipped.",
        request: REQUEST,
      },
      {},
    );
    const ids = async (viewer: User, path: string) =>
      (await (await api(fixture, viewer).get(path)).json()).items.map(
        (listed: any) => listed.id,
      );

    // Ana is not assigned, so the item is not in her Inbox. She is
    // still a Participant, so the Conversation view shows it.
    expect(await ids(ana, "")).toEqual([]);
    expect(await ids(ana, "?conversationId=local:web:shared")).toEqual(
      expect.arrayContaining([item.id, other.id]),
    );
    expect((await api(fixture, ana).get(`/${item.id}`)).status).toBe(200);
    // Cal can view the public Conversation but does not take part in it.
    // He sees its public questions and can answer or dismiss them, like an
    // assignee. They still do not wait on him, and only an assignee takes.
    const calView = await (
      await api(fixture, cal).get("?conversationId=local:web:shared")
    ).json();
    expect(calView.items).toEqual(
      expect.arrayContaining(
        [item.id, other.id].map((id) =>
          expect.objectContaining({
            id,
            canAct: false,
            canAnswer: true,
            canTake: false,
          }),
        ),
      ),
    );
    expect(
      (await api(fixture, cal).act(item.id, { action: "take" })).status,
    ).toBe(403);
    const dismissed = await api(fixture, cal).act(other.id, {
      action: "dismiss",
    });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({
      closedBy: { email: "cal@example.com" },
      status: "dismissed",
    });
    const answered = await api(fixture, cal).act(item.id, {
      action: "submit",
      answer: { values: { decision: ["Approve"] } },
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      closedBy: { email: "cal@example.com" },
      status: "done",
    });
    // The transcript reads the question and its answer from the
    // Conversation alone. It sends no SQL to the Inbox.
    const read = await measureSql(() =>
      api(fixture, ana).questions("local:web:shared"),
    );
    expect(read.result.status).toBe(200);
    expect(
      conversationQuestionsReportSchema.parse(await read.result.json())
        .questions,
    ).toEqual([
      expect.objectContaining({
        answer: expect.objectContaining({
          values: { decision: ["Approve"] },
        }),
        answeredAt: expect.any(String),
        answeredBy: expect.objectContaining({ userId: cal.id }),
        body: "The pull request merged.",
        closedAt: expect.any(String),
        id: item.subject.id,
        request: expect.objectContaining({ question: REQUEST.question }),
        title: "Close the tracking issue?",
      }),
      // A dismissed question closes with no answer.
      {
        body: "The release shipped.",
        closedAt: expect.any(String),
        createdAt: expect.any(String),
        id: other.subject.id,
        request: REQUEST,
        title: "Delete the release branch?",
        updatedAt: expect.any(String),
      },
    ]);
    const tables = read.statements.flatMap(
      (statement) => statement.text.match(/"junior_\w+"/g) ?? [],
    );
    expect(tables).toContain('"junior_questions"');
    expect(tables.filter((table) => table.includes("inbox"))).toEqual([]);
    expect(
      (await api(fixture, ana).questions("local:web:missing")).status,
    ).toBe(404);
    // The answer reaches the Conversation as Cal's own message, so his
    // Turn runs as him.
    const [message] = await pendingMessages("local:web:shared");
    expect(message?.input.text).toContain("cal@example.com answered");
    expect(message?.input.authorId).toBe(cal.id);
  });
});
