import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertInboxItem } from "@/chat/inbox-items/store";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createAskUserQuestionTool } from "@/chat/inbox-items/tools/ask-user-question";
import type {
  InboxItemNoticeRequest,
  InboxItemRequest,
} from "@/chat/inbox-items/request";
import { ask as questions } from "../../../fixtures/questions";
import { expectSqlBudget } from "../../../fixtures/sql-budget";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";

const ROLLOUT_ID = "slack:CPUB:1.000001";
const LATENCY_ID = "slack:CPUB:1.000002";
const ROLLBACK_ID = "slack:CPUB:1.000003";
const OTHER_ID = "slack:CPUB:1.000004";
const OTHER_TENANT_ID = "slack:CEXT:1.000006";
const BUSY_ID = "slack:CPUB:1.000007";
const SMOKE_ID = "slack:CPUB:1.000008";
// A question is about its related links, such as a release page.
const RELEASE_URL = "https://sentry.example.com/releases/payments-v42";
const PR_URL = "https://github.com/getsentry/junior/pull/4164";

const REQUEST = {
  question: "Roll out payments-v42 to every region?",
  fields: [
    {
      id: "go",
      kind: "choice" as const,
      label: "Rollout",
      options: [{ label: "Roll out", recommended: true }, { label: "Hold" }],
    },
  ],
};

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

async function slackConversation(
  conversationId: string,
  channelId: string,
  visibility: "public" | "private",
  teamId = "T123",
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId, channelId },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
}

const services = createSlackInboxItemToolServices(
  createConversationWorkQueueTestAdapter,
);

function context(conversationId: string) {
  return {
    conversationId,
    resolveActorIdentity: async () => undefined,
    source: { kind: "scheduled_automation" as const },
  };
}

async function update(conversationId: string, input: Record<string, unknown>) {
  const tool = createUpdateInboxItemTool(context(conversationId), services);
  return await (tool as any).execute((tool as any).prepareArguments(input), {});
}

// Ask `question` as the agent of `conversationId`, then link
// `conversation_ids`, as an agent does. Parse each input first, as the
// agent runtime does.
async function ask(
  conversationId: string,
  question: string,
  input: { assignees: string[]; conversation_ids?: string[] },
) {
  const tool = createAskUserQuestionTool(context(conversationId), services);
  const added = await (tool as any).execute(
    (tool as any).prepareArguments({
      assignees: input.assignees,
      questions: questions(question),
    }),
    {},
  );
  if (input.conversation_ids) {
    await update(conversationId, {
      id: added.item.id,
      conversation_ids: input.conversation_ids,
    });
  }
  return added;
}

let legacyCount = 0;

// An item that an agent stored before `askUserQuestion`, when an ask or a
// notice could carry related links. Its stored links still show.
async function legacyItem(
  conversationId: string,
  assignee: User,
  item: {
    conversationIds?: string[];
    kind: "action" | "notice";
    request: InboxItemNoticeRequest | InboxItemRequest;
    title: string;
  },
) {
  legacyCount += 1;
  return (await insertInboxItem(getDb(), {
    assignedToEveryone: false,
    assigneeUserIds: [assignee.id],
    body: "Stored before askUserQuestion.",
    conversationIds: item.conversationIds ?? [conversationId],
    kind: item.kind,
    nowMs: Date.now(),
    owner: { id: conversationId, kind: "conversation" },
    request: item.request,
    subject: { id: `ask:legacy-${legacyCount}`, kind: "question" },
    title: item.title,
  }))!;
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (request, next) => {
    request.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return (path: string) =>
    app.request(`http://localhost/api/inbox-items${path}`);
}

describe("inbox item related links", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("shows a question's related links and the open work it links", async () => {
    const fixture = await createConversationFixture();
    for (const id of [
      ROLLOUT_ID,
      LATENCY_ID,
      ROLLBACK_ID,
      OTHER_ID,
      SMOKE_ID,
    ]) {
      await slackConversation(id, "CPUB", "public");
    }
    await slackConversation(OTHER_TENANT_ID, "CEXT", "public", "T999");
    const ana = await user("ana@example.com");
    await user("ben@example.com");
    const links = [
      { label: "Release", url: RELEASE_URL },
      {
        label: "Canary error rate",
        note: "Flat for 30 minutes.",
        url: "https://sentry.example.com/canary",
      },
      {
        conversationId: LATENCY_ID,
        label: "Checkout latency",
        note: "p95 rose after payments-v42.",
      },
    ];
    const rolloutItem = await legacyItem(ROLLOUT_ID, ana, {
      conversationIds: [ROLLOUT_ID, ROLLBACK_ID],
      kind: "action",
      request: { ...REQUEST, related: links },
      title: "Approve the payments-v42 rollout",
    });
    const added = { item: rolloutItem };
    // Other work in the related Conversation, in the linked Conversation,
    // and a question that links the same release. Only the linked
    // Conversation's work is related: a related link relates a question to
    // no other item.
    await ask(LATENCY_ID, "Checkout p95 rose after payments-v42", {
      assignees: ["ana@example.com"],
    });
    const hold = await ask(ROLLBACK_ID, "Hold the payments-v42 deploy", {
      assignees: ["ana@example.com"],
    });
    await legacyItem(SMOKE_ID, ana, {
      kind: "action",
      request: {
        ...REQUEST,
        related: [{ label: "payments-v42", url: RELEASE_URL }],
      },
      title: "Run the payments-v42 smoke tests?",
    });
    await ask(OTHER_ID, "Roll out billing-v7?", {
      assignees: ["ana@example.com"],
    });
    // An open item that Ana cannot see stays out of her related work.
    await ask(OTHER_TENANT_ID, "Release notes elsewhere", {
      assignees: ["ben@example.com"],
    });

    // The page reads its items, then the related work of the whole page at
    // once: the linked work and the access of the linked Conversations.
    // More items do not add statements.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 9,
        serialRounds: 5,
      })
    ).json();
    const rollout = list.items.find(
      (item: { id: string }) => item.id === added.item.id,
    );
    expect(rollout.request.related).toEqual(links);
    // The related links show on the card, but they do not decide it: the
    // subject is the question, which has no link or card of its own.
    expect(rollout.subject).toEqual({
      id: added.item.subject.id,
      kind: "question",
    });
    expect(rollout.related).toEqual({
      conversationIds: [ROLLBACK_ID],
      items: [{ id: hold.item.id, title: "Hold the payments-v42 deploy" }],
    });
    // The single read has the same related work.
    const single = await (await api(fixture, ana)(`/${added.item.id}`)).json();
    expect(single.related).toEqual(rollout.related);

    // New questions keep the stored related links.
    const changed = await update(ROLLOUT_ID, {
      id: added.item.id,
      questions: questions("Approve the payments-v42 rollout now?"),
    });
    expect(changed.item.request.related).toEqual([
      links[0],
      links[1],
      {
        conversation_id: LATENCY_ID,
        label: "Checkout latency",
        note: "p95 rose after payments-v42.",
      },
    ]);
  });

  it("keeps a stored notice's pull request link off its card", async () => {
    // The GitHub plugin's link types read pull request links.
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const fixture = await createConversationFixture();
    await slackConversation(ROLLOUT_ID, "CPUB", "public");
    const ana = await user("ana@example.com");
    const links = [{ label: "The pull request", url: PR_URL }];
    // A stored notice asks nothing, so its request holds only related links.
    const merged = await legacyItem(ROLLOUT_ID, ana, {
      kind: "notice",
      request: { related: links },
      title: "The payments-v42 pull request merged",
    });
    const rollout = await legacyItem(ROLLOUT_ID, ana, {
      kind: "action",
      request: { ...REQUEST, related: links },
      title: "Roll out payments-v42?",
    });

    const list = await (await api(fixture, ana)("")).json();
    const listed = (id: string) =>
      list.items.find((item: { id: string }) => item.id === id);
    // The notice's related link does not decide its card, as for a
    // question.
    expect(listed(merged.id)).toMatchObject({ kind: "notice" });
    expect(listed(merged.id).subject).toEqual(merged.subject);
    // Its card shows the related links instead.
    expect(listed(merged.id).request).toEqual({ related: links });
    // Linking one pull request does not relate the two.
    expect(listed(rollout.id).related).toBeUndefined();
    expect(listed(merged.id).related).toBeUndefined();
    // Only the question is a decision. A question that links a pull
    // request is not a pull request's own ask.
    expect(await (await api(fixture, ana)("/count")).json()).toMatchObject({
      decisions: 1,
      codeChanges: 0,
    });
  });

  it("keeps a quiet Conversation's related work next to a busy one on the page", async () => {
    const fixture = await createConversationFixture();
    for (const id of [ROLLOUT_ID, LATENCY_ID, BUSY_ID]) {
      await slackConversation(id, "CPUB", "public");
    }
    const ana = await user("ana@example.com");
    // The related question is older than every question in the busy
    // Conversation.
    const rose = await ask(LATENCY_ID, "Checkout p95 rose after payments-v42", {
      assignees: ["ana@example.com"],
    });
    const start = Date.now();
    for (let index = 1; index <= 210; index += 1) {
      await insertInboxItem(getDb(), {
        owner: { id: BUSY_ID, kind: "conversation" },
        assignedToEveryone: false,
        assigneeUserIds: [ana.id],
        body: "Busy release.",
        conversationIds: [BUSY_ID],
        kind: "action",
        nowMs: start + index,
        request: REQUEST,
        subject: { id: `busy:${index}`, kind: "question" },
        title: `Busy release ${index}`,
      });
    }
    const busy = await ask(ROLLOUT_ID, "Hold the busy release?", {
      assignees: ["ana@example.com"],
      conversation_ids: [BUSY_ID],
    });
    const added = await ask(ROLLOUT_ID, "Approve the payments-v42 rollout?", {
      assignees: ["ana@example.com"],
      conversation_ids: [LATENCY_ID],
    });

    // The busy Conversation keeps only its own newest candidates, so the
    // quiet one on the same page still finds its older related question.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 8,
        serialRounds: 5,
      })
    ).json();
    const listed = (id: string) =>
      list.items.find((item: { id: string }) => item.id === id);
    expect(listed(busy.item.id).related.items).toHaveLength(10);
    expect(listed(added.item.id).related.items).toEqual([
      { id: rose.item.id, title: "Checkout p95 rose after payments-v42" },
    ]);
  });
});
