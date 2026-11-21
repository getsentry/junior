import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertInboxItem } from "@/chat/inbox-items/store";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
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
const PRIVATE_ID = "slack:DPRIV:1.000005";
const OTHER_TENANT_ID = "slack:CEXT:1.000006";
const BUSY_ID = "slack:CPUB:1.000007";
const RELEASE = "release:payments-v42";

const REQUEST = {
  question: "Roll out payments-v42 to every region?",
  fields: [
    {
      id: "go",
      kind: "choice",
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

// Parse the input first, as the agent runtime does.
async function add(conversationId: string, input: Record<string, unknown>) {
  const tool = createAddInboxItemTool(context(conversationId), services);
  return await (tool as any).execute((tool as any).prepareArguments(input), {});
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

describe("inbox item evidence", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("shows a question's evidence and the open work on the same release", async () => {
    const fixture = await createConversationFixture();
    for (const id of [ROLLOUT_ID, LATENCY_ID, ROLLBACK_ID, OTHER_ID]) {
      await slackConversation(id, "CPUB", "public");
    }
    await slackConversation(PRIVATE_ID, "DPRIV", "private");
    await slackConversation(OTHER_TENANT_ID, "CEXT", "public", "T999");
    const ana = await user("ana@example.com");
    await user("ben@example.com");
    const subject = { id: RELEASE, title: "payments-v42" };
    const evidence = [
      {
        label: "Canary error rate",
        note: "Flat for 30 minutes.",
        url: "https://sentry.example.com/canary",
      },
      {
        conversation_id: LATENCY_ID,
        label: "Checkout latency",
        note: "p95 rose after payments-v42.",
      },
    ];
    const ask = {
      assignees: ["ana@example.com"],
      body: "The canary is clean.",
      conversation_ids: [ROLLBACK_ID],
      dedupe_key: "rollout:payments-v42",
      kind: "action",
      request: { ...REQUEST, evidence },
      subject,
      title: "Approve the payments-v42 rollout",
    };

    // Each entry names one source, and a cited Conversation passes the
    // link check, so a private one cannot reach a public item.
    await expect(
      add(ROLLOUT_ID, {
        ...ask,
        request: {
          ...REQUEST,
          evidence: [
            {
              label: "Both",
              url: evidence[0]!.url,
              conversation_id: LATENCY_ID,
            },
          ],
        },
      }),
    ).rejects.toThrow("needs a `url` or a `conversation_id`");
    await expect(
      add(ROLLOUT_ID, {
        ...ask,
        request: {
          ...REQUEST,
          evidence: [{ label: "DM", conversation_id: PRIVATE_ID }],
        },
      }),
    ).rejects.toThrow(`Conversation ${PRIVATE_ID} is not found.`);
    await expect(
      add(ROLLOUT_ID, {
        ...ask,
        request: {
          ...REQUEST,
          evidence: [{ label: "Script", url: "javascript:alert(1)" }],
        },
      }),
    ).rejects.toThrow("Use an http(s) URL.");

    const added = await add(ROLLOUT_ID, ask);
    expect(added.item.request.evidence).toEqual(evidence);
    // Other work on the same release, and in the linked Conversation.
    const rose = await add(LATENCY_ID, {
      assignees: ["ana@example.com"],
      body: "p95 went from 210 ms to 890 ms after payments-v42.",
      kind: "notice",
      subject,
      title: "Checkout p95 rose after payments-v42",
    });
    const hold = await add(ROLLBACK_ID, {
      assignees: ["ana@example.com"],
      body: "Morgan asked to hold the deploy.",
      kind: "notice",
      title: "Hold the payments-v42 deploy",
    });
    await add(OTHER_ID, {
      assignees: ["ana@example.com"],
      body: "Unrelated.",
      kind: "notice",
      subject: { id: "release:billing-v7" },
      title: "Billing v7 is out",
    });
    // An open item that Ana cannot see stays out of her related work.
    await add(OTHER_TENANT_ID, {
      assignees: ["ben@example.com"],
      body: "Notes in another workspace.",
      kind: "notice",
      subject,
      title: "Release notes elsewhere",
    });

    // The page reads its items, then the related work of the whole page at
    // once: the same subject, the linked work, and the access of the linked
    // Conversations. More items do not add statements.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 10,
        serialRounds: 5,
      })
    ).json();
    const rollout = list.items.find(
      (item: { id: string }) => item.id === added.item.id,
    );
    expect(rollout.request.evidence).toEqual([
      evidence[0],
      {
        conversationId: LATENCY_ID,
        label: "Checkout latency",
        note: "p95 rose after payments-v42.",
      },
    ]);
    expect(rollout.related).toEqual({
      conversationIds: [ROLLBACK_ID],
      items: [
        { id: hold.item.id, title: "Hold the payments-v42 deploy" },
        { id: rose.item.id, title: "Checkout p95 rose after payments-v42" },
      ],
    });
    // The single read has the same related work.
    const single = await (await api(fixture, ana)(`/${added.item.id}`)).json();
    expect(single.related).toEqual(rollout.related);

    // A change that does not name the evidence keeps it.
    const update = createUpdateInboxItemTool(context(ROLLOUT_ID), services);
    const changed = await (update as any).execute(
      (update as any).prepareArguments({
        id: added.item.id,
        title: "Approve the payments-v42 rollout now",
      }),
      {},
    );
    expect(changed.item.request.evidence).toEqual(evidence);
  });

  it("keeps a quiet subject's related work next to a busy subject on the page", async () => {
    const fixture = await createConversationFixture();
    for (const id of [ROLLOUT_ID, LATENCY_ID, BUSY_ID]) {
      await slackConversation(id, "CPUB", "public");
    }
    const ana = await user("ana@example.com");
    const subject = { id: RELEASE, title: "payments-v42" };
    // The related notice is older than every item on the busy subject.
    const rose = await add(LATENCY_ID, {
      assignees: ["ana@example.com"],
      body: "p95 went from 210 ms to 890 ms after payments-v42.",
      kind: "notice",
      subject,
      title: "Checkout p95 rose after payments-v42",
    });
    const tenant = { provider: "slack", providerTenantId: "T123" };
    const start = Date.now();
    for (let index = 1; index <= 210; index += 1) {
      await insertInboxItem(getDb(), {
        owner: { id: BUSY_ID, kind: "conversation" },
        assignedToEveryone: false,
        assigneeUserIds: [ana.id],
        body: "Busy release.",
        conversationIds: [BUSY_ID],
        dedupeKey: `busy:${index}`,
        kind: "notice",
        nowMs: start + index,
        subject: { id: "release:busy" },
        tenant,
        title: `Busy release ${index}`,
        visibility: "public",
      });
    }
    const added = await add(ROLLOUT_ID, {
      assignees: ["ana@example.com"],
      body: "The canary is clean.",
      kind: "action",
      request: REQUEST,
      subject,
      title: "Approve the payments-v42 rollout",
    });

    // The busy subject keeps only its own newest candidates, so the quiet
    // subject on the same page still finds its older related notice.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 8,
        serialRounds: 5,
      })
    ).json();
    expect(
      list.items.some(
        (item: { subject?: { id: string } }) =>
          item.subject?.id === "release:busy",
      ),
    ).toBe(true);
    const rollout = list.items.find(
      (item: { id: string }) => item.id === added.item.id,
    );
    expect(rollout.related.items).toEqual([
      { id: rose.item.id, title: "Checkout p95 rose after payments-v42" },
    ]);
  });
});
