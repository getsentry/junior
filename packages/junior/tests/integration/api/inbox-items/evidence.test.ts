import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { githubPlugin } from "@sentry/junior-github";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { recordCodeChange } from "@/chat/code/store";
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
const SMOKE_ID = "slack:CPUB:1.000008";
// A question is about the links of its evidence, such as a release page.
const RELEASE_URL = "https://sentry.example.com/releases/payments-v42";
const BUSY_URL = "https://sentry.example.com/releases/busy";
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
    for (const id of [
      ROLLOUT_ID,
      LATENCY_ID,
      ROLLBACK_ID,
      OTHER_ID,
      SMOKE_ID,
    ]) {
      await slackConversation(id, "CPUB", "public");
    }
    await slackConversation(PRIVATE_ID, "DPRIV", "private");
    await slackConversation(OTHER_TENANT_ID, "CEXT", "public", "T999");
    const ana = await user("ana@example.com");
    await user("ben@example.com");
    const evidence = [
      { label: "Release", url: RELEASE_URL },
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
              url: RELEASE_URL,
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
    // Other work in the cited Conversation, in the linked Conversation, and
    // a question that cites the same release.
    const rose = await add(LATENCY_ID, {
      assignees: ["ana@example.com"],
      body: "p95 went from 210 ms to 890 ms after payments-v42.",
      kind: "notice",
      title: "Checkout p95 rose after payments-v42",
    });
    const hold = await add(ROLLBACK_ID, {
      assignees: ["ana@example.com"],
      body: "Morgan asked to hold the deploy.",
      kind: "notice",
      title: "Hold the payments-v42 deploy",
    });
    const smoke = await add(SMOKE_ID, {
      assignees: ["ana@example.com"],
      body: "The smoke tests have not run yet.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [{ label: "payments-v42", url: RELEASE_URL }],
      },
      title: "Run the payments-v42 smoke tests?",
    });
    await add(OTHER_ID, {
      assignees: ["ana@example.com"],
      body: "Unrelated.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [
          {
            label: "billing-v7",
            url: "https://sentry.example.com/releases/billing-v7",
          },
        ],
      },
      title: "Roll out billing-v7?",
    });
    // An open item that Ana cannot see stays out of her related work.
    await add(OTHER_TENANT_ID, {
      assignees: ["ben@example.com"],
      body: "Notes in another workspace.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [{ label: "payments-v42", url: RELEASE_URL }],
      },
      title: "Release notes elsewhere",
    });

    // The page reads its items, then the related work of the whole page at
    // once: the same release, the linked and cited work, and the access of
    // the linked Conversations. More items do not add statements.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 9,
        serialRounds: 5,
      })
    ).json();
    const rollout = list.items.find(
      (item: { id: string }) => item.id === added.item.id,
    );
    expect(rollout.request.evidence).toEqual([
      evidence[0],
      evidence[1],
      {
        conversationId: LATENCY_ID,
        label: "Checkout latency",
        note: "p95 rose after payments-v42.",
      },
    ]);
    // The question's first evidence link is its card.
    expect(rollout.subject).toMatchObject({
      id: "rollout:payments-v42",
      kind: "question",
      url: RELEASE_URL,
    });
    expect(rollout.related).toEqual({
      conversationIds: [ROLLBACK_ID],
      items: [
        { id: smoke.item.id, title: "Run the payments-v42 smoke tests?" },
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

  it("links an agent notice to the pull request that it cites", async () => {
    // The GitHub plugin's link types read pull request links.
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const fixture = await createConversationFixture();
    await slackConversation(ROLLOUT_ID, "CPUB", "public");
    const ana = await user("ana@example.com");
    const cites = [{ label: "The pull request", url: PR_URL }];
    const notice = {
      assignees: ["ana@example.com"],
      body: "It merged after the canary passed.",
      kind: "notice",
      title: "The payments-v42 pull request merged",
    };

    // A notice asks nothing, so its request holds only evidence.
    await expect(
      add(ROLLOUT_ID, { ...notice, request: { ...REQUEST, evidence: cites } }),
    ).rejects.toThrow("A notice asks nothing");
    const merged = await add(ROLLOUT_ID, {
      ...notice,
      request: { evidence: cites },
    });
    expect(merged.item.request).toEqual({ evidence: cites });
    const rollout = await add(ROLLOUT_ID, {
      assignees: ["ana@example.com"],
      body: "The pull request merged.",
      kind: "action",
      request: { ...REQUEST, evidence: cites },
      title: "Roll out payments-v42?",
    });

    const list = await (await api(fixture, ana)("")).json();
    const listed = (id: string) =>
      list.items.find((item: { id: string }) => item.id === id);
    // The notice's evidence link is its card, like a question's.
    expect(listed(merged.item.id)).toMatchObject({
      kind: "notice",
      subject: { kind: "question", objectType: "code_change", url: PR_URL },
    });
    expect(listed(merged.item.id).request).toBeUndefined();
    expect(listed(rollout.item.id).related.items).toEqual([
      { id: merged.item.id, title: "The payments-v42 pull request merged" },
    ]);
    expect(listed(merged.item.id).related.items).toEqual([
      { id: rollout.item.id, title: "Roll out payments-v42?" },
    ]);
    // Only the question is a decision. A question that cites a pull
    // request is not a pull request's own ask.
    expect(await (await api(fixture, ana)("/count")).json()).toMatchObject({
      decisions: 1,
      codeChanges: 0,
    });
  });

  it("relates a pull request's own ask and a question that cites it", async () => {
    // The GitHub plugin builds and reads pull request links.
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const fixture = await createConversationFixture();
    await slackConversation(ROLLOUT_ID, "CPUB", "public");
    await slackConversation(LATENCY_ID, "CPUB", "public");
    const ana = await user("ana@example.com");
    await recordCodeChange(getDb(), "github", {
      conversationIds: [LATENCY_ID],
      number: 4164,
      openedAt: new Date("2026-10-01T11:00:00.000Z"),
      providerId: "4164001",
      repository: { name: "getsentry/junior", providerId: "repository-1" },
      state: "open",
      title: "Name Inbox items by subject",
      updatedAt: new Date("2026-10-01T11:00:00.000Z"),
    });
    // The GitHub plugin names the pull request by its GitHub id.
    const review = await insertInboxItem(getDb(), {
      assignedToEveryone: false,
      assigneeUserIds: [ana.id],
      body: "Ana was asked to review it.",
      conversationIds: [LATENCY_ID],
      kind: "action",
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      owner: { id: LATENCY_ID, kind: "conversation" },
      subject: { id: "4164001", kind: "github:pull_request" },
      title: "Review requested · #4164",
      visibility: "public",
    });
    if (!review) throw new Error("the review ask was not added");
    // A question in another Conversation cites the pull request's page.
    const rollout = await add(ROLLOUT_ID, {
      assignees: ["ana@example.com"],
      body: "The pull request is up.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [{ label: "The pull request", url: PR_URL }],
      },
      title: "Roll out payments-v42?",
    });

    const list = await (await api(fixture, ana)("")).json();
    const listed = (id: string) =>
      list.items.find((item: { id: string }) => item.id === id);
    expect(listed(rollout.item.id).related.items).toEqual([
      { id: review.id, title: "Review requested · #4164" },
    ]);
    expect(listed(review.id).related.items).toEqual([
      { id: rollout.item.id, title: "Roll out payments-v42?" },
    ]);
  });

  it("relates two items that cite one link, in the form that each stored", async () => {
    const fixture = await createConversationFixture();
    await slackConversation(ROLLOUT_ID, "CPUB", "public");
    await slackConversation(LATENCY_ID, "CPUB", "public");
    const ana = await user("ana@example.com");
    // Rows added before links were stored as `URL.href` keep the text that
    // the agent sent.
    const stored = [];
    for (const [conversationId, title] of [
      [ROLLOUT_ID, "Roll out the status page?"],
      [LATENCY_ID, "Hold the status page?"],
    ] as const) {
      const item = await insertInboxItem(getDb(), {
        assignedToEveryone: false,
        assigneeUserIds: [ana.id],
        body: "The status page is up.",
        conversationIds: [conversationId],
        kind: "action",
        nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
        owner: { id: conversationId, kind: "conversation" },
        request: {
          ...REQUEST,
          evidence: [{ label: "Status", url: "https://status.example.com" }],
        },
        subject: { id: `status:${conversationId}`, kind: "question" },
        title,
        visibility: "public",
      });
      if (!item) throw new Error(`${title} was not added`);
      stored.push(item.id);
    }
    // New items store each link as `URL.href`, so two ways to write one
    // link name the same object.
    const upper = await add(ROLLOUT_ID, {
      assignees: ["ana@example.com"],
      body: "Its docs moved.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [{ label: "Docs", url: "https://Example.com" }],
      },
      title: "Publish the docs?",
    });
    expect(upper.item.request.evidence).toEqual([
      { label: "Docs", url: "https://example.com/" },
    ]);
    const lower = await add(LATENCY_ID, {
      assignees: ["ana@example.com"],
      body: "Its docs moved.",
      kind: "action",
      request: {
        ...REQUEST,
        evidence: [{ label: "Docs", url: "https://example.com/" }],
      },
      title: "Announce the docs?",
    });

    const list = await (await api(fixture, ana)("")).json();
    const related = (id: string) =>
      list.items
        .find((item: { id: string }) => item.id === id)
        .related.items.map((item: { id: string }) => item.id);
    expect(related(stored[0]!)).toEqual([stored[1]]);
    expect(related(stored[1]!)).toEqual([stored[0]]);
    expect(related(upper.item.id)).toEqual([lower.item.id]);
    expect(related(lower.item.id)).toEqual([upper.item.id]);
  });

  it("keeps a quiet release's related work next to a busy release on the page", async () => {
    const fixture = await createConversationFixture();
    for (const id of [ROLLOUT_ID, LATENCY_ID, BUSY_ID]) {
      await slackConversation(id, "CPUB", "public");
    }
    const ana = await user("ana@example.com");
    const cites = (url: string) => ({
      ...REQUEST,
      evidence: [{ label: "Release", url }],
    });
    // The related question is older than every question on the busy
    // release.
    const rose = await add(LATENCY_ID, {
      assignees: ["ana@example.com"],
      body: "p95 went from 210 ms to 890 ms after payments-v42.",
      kind: "action",
      request: cites(RELEASE_URL),
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
        kind: "action",
        nowMs: start + index,
        request: cites(BUSY_URL),
        subject: { id: `busy:${index}`, kind: "question" },
        tenant,
        title: `Busy release ${index}`,
        visibility: "public",
      });
    }
    const added = await add(ROLLOUT_ID, {
      assignees: ["ana@example.com"],
      body: "The canary is clean.",
      kind: "action",
      request: cites(RELEASE_URL),
      title: "Approve the payments-v42 rollout",
    });

    // The busy release keeps only its own newest candidates, so the quiet
    // release on the same page still finds its older related question.
    const list = await (
      await expectSqlBudget(() => api(fixture, ana)("?sort=waiting"), {
        statements: 8,
        serialRounds: 5,
      })
    ).json();
    expect(
      list.items.some(
        (item: { subject?: { url?: string } }) =>
          item.subject?.url === BUSY_URL,
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
