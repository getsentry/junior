import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { githubPlugin } from "@sentry/junior-github";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  juniorConversationParticipants,
  juniorInboxItemAssignees,
  juniorInboxItems,
} from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
} from "../fixtures/agent-invocations";

const BOT = "sentry-junior[bot]";
const person = slackInvocationInput.actor;
const issueUrl = (number: number) =>
  `https://github.com/getsentry/junior/issues/${number}`;

let app: Awaited<ReturnType<typeof createApp>>;

/** Send a signed GitHub webhook through the app route. */
async function sendGitHubWebhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { full_name: "getsentry/junior", id: 2001 },
    sender: { login: BOT },
    ...payload,
  });
  const response = await app.fetch(
    new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": `delivery-${event}-${Math.random()}`,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
          .update(body)
          .digest("hex")}`,
      },
      body,
    }),
  );
  expect(response.status).toBe(202);
}

/** The issue bodies and the assignees that Junior sent to GitHub. */
const sent = {
  assignees: new Map<number, string[]>(),
  bodies: new Map<number, string>(),
};

/**
 * Open an issue from the person's Turn, as Junior does. GitHub assigns each
 * login that Junior sends.
 */
async function createIssue(number: number, reviewBy: string[]) {
  return await getPluginTools({
    actor: person,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    egress: {
      fetch: async ({ request }) => {
        const body = (await request.json()) as {
          assignees?: string[];
          body?: string;
        };
        if (new URL(request.url).pathname.endsWith("/assignees")) {
          sent.assignees.set(number, body.assignees ?? []);
          return Response.json({
            assignees: (body.assignees ?? []).map((login) => ({ login })),
            number,
          });
        }
        sent.bodies.set(number, body.body ?? "");
        return Response.json(
          { html_url: issueUrl(number), number },
          { status: 201 },
        );
      },
    },
    resolveActorIdentity: async () => await readActorIdentity(person),
    source: { kind: "parent_message" },
    turnTools: turnBehavior({ kind: "task", personInput: false }).tools,
    workspace: {} as never,
  })["github_createIssue"]!.execute!(
    {
      body: "Should the Inbox group asks by repository?",
      repo: "getsentry/junior",
      review_by: reviewBy,
      title: "Design: Group Inbox asks",
    },
    { toolCallId: `create-issue-${number}` },
  );
}

/** The review item of an issue, and who it is assigned to. */
async function reviewItem(number: number) {
  const [item] = await getDb()
    .select({
      id: juniorInboxItems.id,
      kind: juniorInboxItems.kind,
      status: juniorInboxItems.status,
      title: juniorInboxItems.title,
    })
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.subjectId, issueUrl(number)));
  if (!item) return undefined;
  const assignees = await getDb()
    .select({ userId: juniorInboxItemAssignees.userId })
    .from(juniorInboxItemAssignees)
    .where(eq(juniorInboxItemAssignees.itemId, item.id));
  return {
    assignees: assignees.map((assignee) => assignee.userId),
    kind: item.kind,
    status: item.status,
    title: item.title,
  };
}

/** A Slack person in this workspace who linked a GitHub account. */
async function linkedPerson(slackUserId: string, login: string) {
  const identity = await upsertIdentity(getSqlExecutor(), {
    displayName: login,
    email: `${login}@example.com`,
    emailVerified: true,
    kind: "user",
    provider: "slack",
    providerSubjectId: slackUserId,
    providerTenantId: person.teamId,
  });
  if (!identity.userId) throw new Error("missing linked user");
  await upsertLinkedIdentity(getSqlExecutor(), identity.userId, {
    handle: login,
    kind: "user",
    provider: "github",
    providerSubjectId: `${login}-id`,
  });
  return identity.userId;
}

describe("an issue that Junior opens for a person's review", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await disconnectStateAdapter();
  });

  it("asks each reviewer until they comment or the issue closes", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const { fixture } = await prepareSlackParentConversation();
    const previousDashboard = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      await migratePluginSchemas(fixture.sql, [
        {
          dir: path.resolve(process.cwd(), "../junior-github/migrations"),
          pluginName: "github",
        },
      ]);
      const reviewer = await linkedPerson(person.userId, "pat-gh");
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          lastMessageAt: new Date(1),
          rootConversationId: slackParentConversationId,
          userId: reviewer,
        });
      // Sam linked GitHub, but is not in this Conversation.
      await linkedPerson("U0SAM", "sam-gh");
      // Slack mentions reach the tool as the `@login` of the linked account.
      await expect(
        createIssue(77, [`<@${person.userId}>`, "<@U0SAM>"]),
      ).resolves.toMatchObject({
        review_left_out: [
          {
            person: "@sam-gh",
            reason: "Is not in this Conversation, so they cannot get an item.",
          },
        ],
        review_requested: ["pat-gh"],
      });
      // Only the reviewer in this Conversation is assigned on GitHub.
      expect(sent.assignees.get(77)).toEqual(["pat-gh"]);
      expect(await reviewItem(77)).toEqual({
        assignees: [reviewer],
        kind: "action",
        status: "open",
        title: "Review requested · #77",
      });

      // A comment by another person does not answer for the reviewer.
      const comment = (login: string) =>
        sendGitHubWebhook("issue_comment", {
          action: "created",
          comment: { body: "Looks fine", id: 1, user: { login } },
          issue: {
            assignees: [{ login: "pat-gh" }],
            body: sent.bodies.get(77),
            number: 77,
            user: { login: BOT },
          },
        });
      await comment("someone-else");
      expect(await reviewItem(77)).toMatchObject({ status: "open" });
      await comment("Pat-GH");
      expect(await reviewItem(77)).toMatchObject({ status: "done" });

      await createIssue(78, [`<@${person.userId}>`]);
      expect(await reviewItem(78)).toMatchObject({ status: "open" });
      const lifecycle = (action: string) =>
        sendGitHubWebhook("issues", {
          action,
          issue: {
            // Someone who claimed the issue has no item, so nothing closes
            // for them.
            assignees: [{ login: "pat-gh" }, { login: "claimer-gh" }],
            body: sent.bodies.get(78),
            closed_at: action === "closed" ? "2026-07-02T12:00:00Z" : null,
            created_at: "2026-07-01T12:00:00Z",
            id: 78_000,
            number: 78,
            updated_at: "2026-07-02T12:00:00Z",
            user: { login: BOT },
          },
        });
      await lifecycle("closed");
      expect(await reviewItem(78)).toMatchObject({ status: "done" });
      // A reopen does not ask again.
      await lifecycle("reopened");
      expect(await reviewItem(78)).toMatchObject({ status: "done" });
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
});
