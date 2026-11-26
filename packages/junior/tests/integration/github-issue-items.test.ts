import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { githubPlugin } from "@sentry/junior-github";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { recordConversationParticipant } from "@/chat/conversations/sql/participants";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import { getDb, getSqlExecutor } from "@/chat/db";
import { getPluginTools } from "@/chat/plugins/hooks/tools";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { InboxItemPayload } from "@/api/schema";
import {
  juniorConversationAnnotations,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorInboxItemAssignees,
  juniorInboxItems,
  juniorUsers,
} from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackSpawnInput,
  slackParentConversationId,
} from "../fixtures/child-agents";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { seedConversation } from "../fixtures/conversation-retention";
import { seedLinkedPerson } from "../fixtures/slack-user";
import { signedInViewer } from "../fixtures/user";
import { mswServer } from "../msw/server";

const ISSUE_URL = "https://github.com/getsentry/junior/issues/4254";
// GitHub's id of the issue, which names its Inbox item.
const ISSUE_ID = 4254000;
const BOT = "sentry-junior[bot]";
const person = slackSpawnInput.actor;

let app: Awaited<ReturnType<typeof createApp>>;

/** Send a signed GitHub webhook through the app route. */
async function sendGitHubWebhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { full_name: "getsentry/junior", id: 2001 },
    sender: { login: "maintainer" },
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

/** Open issue #4254 from the person's Turn, as Junior does. */
async function createIssue(): Promise<string> {
  const created: string[] = [];
  await getPluginTools({
    actor: person,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    egress: {
      fetch: async ({ request }) => {
        created.push(((await request.json()) as { body: string }).body);
        return Response.json(
          { html_url: ISSUE_URL, id: ISSUE_ID, number: 4254 },
          { status: 201 },
        );
      },
    },
    resolveActorIdentity: async () => await readActorIdentity(person),
    source: { kind: "parent_message" },
    turnTools: turnBehavior({
      kind: "task",
      hasParent: true,
      personInput: false,
    }).tools,
    workspace: {} as never,
  })["github_createIssue"]!.execute!(
    {
      body: "Fix the flaky check.",
      repo: "getsentry/junior",
      title: "Fix the flaky check",
    },
    { toolCallId: "create-issue" },
  );
  return created[0]!;
}

/** An `issues` webhook for issue #4254 with these assignees. */
function issueEvent(
  body: string,
  action: string,
  assignees: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    issue: {
      assignees: assignees.map((login) => ({ login })),
      body,
      html_url: ISSUE_URL,
      id: ISSUE_ID,
      number: 4254,
      state: action === "closed" ? "closed" : "open",
      user: { login: BOT },
    },
    ...extra,
  };
}

/** The issue's item and the emails of the people on it. */
async function issueItem() {
  const [item] = await getDb()
    .select({ id: juniorInboxItems.id, status: juniorInboxItems.status })
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.subjectKind, "github:issue"),
        eq(juniorInboxItems.subjectId, String(ISSUE_ID)),
      ),
    )
    .orderBy(desc(juniorInboxItems.createdAt))
    .limit(1);
  if (!item) return undefined;
  const people = await getDb()
    .select({ email: juniorUsers.primaryEmail })
    .from(juniorInboxItemAssignees)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorInboxItemAssignees.userId))
    .where(eq(juniorInboxItemAssignees.itemId, item.id));
  return {
    ...item,
    assignees: people.map((row) => row.email).sort(),
  };
}

/** The Junior API as the signed-in person with this email. */
async function apiAs(email: string) {
  const viewer = await signedInViewer(email);
  const api = new Hono<JuniorApiEnv>();
  api.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  api.route("/", createJuniorApi());
  return api;
}

/** Act on the item as the signed-in person with this email. */
async function actAs(
  email: string,
  itemId: string,
  action: "dismiss" | "take",
): Promise<number> {
  const response = await (
    await apiAs(email)
  ).request(`http://localhost/api/inbox-items/${itemId}/actions`, {
    body: JSON.stringify({ action }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return response.status;
}

/** Dismiss the item as the signed-in person with this email. */
async function dismissAs(email: string, itemId: string): Promise<number> {
  return await actAs(email, itemId, "dismiss");
}

/** The open items that the person's Inbox lists. */
async function inboxOf(email: string): Promise<InboxItemPayload[]> {
  const response = await (
    await apiAs(email)
  ).request("http://localhost/api/inbox-items?for=viewer");
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: InboxItemPayload[] }).items;
}

/** Make the issue's Conversation and its Destination private. */
async function makeConversationPrivate(): Promise<void> {
  await getDb().update(juniorDestinations).set({ visibility: "private" });
  await getDb().update(juniorConversations).set({ visibility: "private" });
}

describe("the Inbox item of an issue that Junior created", () => {
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

  it("follows the GitHub assignees, and a dismiss unassigns only the person who dismissed it", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    await seedLinkedPerson({
      email: "sam@example.com",
      linked: { handle: "sam", provider: "github", subjectId: "2003" },
      slackUserId: "U_SAM",
    });
    const { fixture } = await prepareSlackParentConversation();
    // Only the people in the issue's Conversation can be on its item.
    const people = await getDb()
      .select({ id: juniorIdentities.id })
      .from(juniorIdentities)
      .where(
        inArray(juniorIdentities.providerSubjectId, [person.userId, "U_SAM"]),
      );
    for (const identity of people) {
      await recordConversationParticipant(getSqlExecutor(), {
        actorIdentityId: identity.id,
        atMs: Date.now(),
        conversationId: slackParentConversationId,
      });
    }
    // The footer that links the issue to its Conversation needs a
    // dashboard link.
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
      const unassigned: unknown[] = [];
      const refuse = new Set<string>();
      let gone = false;
      mswServer.use(
        http.delete(
          "https://api.github.com/repos/getsentry/junior/issues/4254/assignees",
          async ({ request }) => {
            const body = (await request.json()) as { assignees: string[] };
            if (gone) {
              return HttpResponse.json(
                { message: "This issue was deleted" },
                { status: 410 },
              );
            }
            if (body.assignees.some((login) => refuse.has(login))) {
              return HttpResponse.json(
                { message: "Must have admin rights" },
                { status: 403 },
              );
            }
            unassigned.push(body);
            return HttpResponse.json({ assignees: [] });
          },
        ),
      );

      const body = await createIssue();
      // Another Conversation attached a link to the issue before the card
      // was saved. A link does not make that Conversation the item's owner.
      await seedConversation(getSqlExecutor(), {
        conversationId: "slack:C999:1.0001",
        lastActivityAtMs: Date.now(),
      });
      await getDb()
        .insert(juniorConversationAnnotations)
        .values({
          annotation: { key: "getsentry/junior#4254", kind: "resource_link" },
          conversationId: "slack:C999:1.0001",
          createdAt: new Date(0),
          key: "getsentry/junior#4254",
          kind: "resource_link",
          plugin: "github",
          subjectId: String(ISSUE_ID),
          subjectKind: "github:issue",
          updatedAt: new Date(0),
          url: ISSUE_URL,
        });
      // Opening an issue asks nobody.
      await sendGitHubWebhook("issues", issueEvent(body, "opened", []));
      expect(await issueItem()).toBeUndefined();

      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat"], { assignee: { login: "pat" } }),
      );
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat", "sam", "nolink"], {
          assignee: { login: "sam" },
        }),
      );
      const item = await issueItem();
      // An assignee with no linked account is not on the item.
      expect(item).toMatchObject({
        assignees: ["pat@example.com", "sam@example.com"],
        status: "open",
      });
      // The GitHub assignees are on the item, so nobody can take it.
      expect(
        (await inboxOf("pat@example.com")).find(
          (listed) => listed.id === item!.id,
        ),
      ).toMatchObject({ canTake: false });
      expect(await actAs("pat@example.com", item!.id, "take")).toBe(400);

      // Pat's dismiss unassigns Pat on GitHub, and Sam stays on the item.
      expect(await dismissAs("pat@example.com", item!.id)).toBe(200);
      expect(unassigned).toEqual([{ assignees: ["pat"] }]);
      expect(await issueItem()).toMatchObject({
        assignees: ["sam@example.com"],
        status: "open",
      });

      // GitHub refuses to unassign Sam, so the dismiss fails and Sam stays.
      refuse.add("sam");
      expect(await dismissAs("sam@example.com", item!.id)).toBe(409);
      expect(await issueItem()).toMatchObject({
        assignees: ["sam@example.com"],
        status: "open",
      });

      // Pat is assigned again on GitHub, then Sam is unassigned there.
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat", "sam"], {
          assignee: { login: "pat" },
        }),
      );
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "unassigned", ["pat"], {
          assignee: { login: "sam" },
        }),
      );
      expect(await issueItem()).toMatchObject({
        assignees: ["pat@example.com"],
        status: "open",
      });

      await sendGitHubWebhook("issues", issueEvent(body, "closed", ["pat"]));
      expect(await issueItem()).toMatchObject({ status: "done" });

      // A reopen brings the item back for Pat, who is still assigned. Sam
      // joins it when assigned. Then Pat and Sam both dismiss at once. The
      // second one to leave is the last, so the item closes and nobody is
      // left.
      await sendGitHubWebhook("issues", issueEvent(body, "reopened", ["pat"]));
      expect(await issueItem()).toMatchObject({
        assignees: ["pat@example.com"],
        status: "open",
      });
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat", "sam"], {
          assignee: { login: "sam" },
        }),
      );
      const again = await issueItem();
      expect(again).toMatchObject({
        assignees: ["pat@example.com", "sam@example.com"],
        status: "open",
      });
      refuse.clear();
      expect(
        await Promise.all([
          dismissAs("pat@example.com", again!.id),
          dismissAs("sam@example.com", again!.id),
        ]),
      ).toEqual([200, 200]);
      expect(await issueItem()).toMatchObject({ status: "dismissed" });
      // An unassign after the item closed asks nobody, so it brings no
      // item back for whoever is still assigned.
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "unassigned", ["pat"], { assignee: { login: "sam" } }),
      );
      expect(await issueItem()).toMatchObject({ status: "dismissed" });

      // Once the issue is gone from GitHub, nobody is left to unassign, so
      // a dismiss still takes the person off the item.
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat"], { assignee: { login: "pat" } }),
      );
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat", "sam"], {
          assignee: { login: "sam" },
        }),
      );
      const gonePat = await issueItem();
      expect(gonePat).toMatchObject({
        assignees: ["pat@example.com", "sam@example.com"],
        status: "open",
      });
      gone = true;
      expect(await dismissAs("pat@example.com", gonePat!.id)).toBe(200);
      expect(await issueItem()).toMatchObject({
        assignees: ["sam@example.com"],
        status: "open",
      });
      // Deleting the issue closes its item.
      await sendGitHubWebhook("issues", issueEvent(body, "deleted", ["sam"]));
      expect(await issueItem()).toMatchObject({ status: "done" });

      // The other Conversation's earlier link becomes a card, so it owns
      // the issue, and the footer does not name it. A new ask skips the
      // issue with no item, and GitHub gets no failure to retry.
      await getDb()
        .update(juniorConversationAnnotations)
        .set({
          annotation: {
            key: "getsentry/junior#4254",
            kind: "object",
            objectType: "task",
          },
          kind: "object",
        })
        .where(
          eq(juniorConversationAnnotations.conversationId, "slack:C999:1.0001"),
        );
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["pat"], { assignee: { login: "pat" } }),
      );
      expect(await issueItem()).toMatchObject({ status: "done" });
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
  it("puts an assignee from outside a private Conversation on the item, without the Conversation", async () => {
    app = await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
    // Out is not in the issue's Conversation, but is assigned on GitHub.
    await seedLinkedPerson({
      email: "out@example.com",
      linked: { handle: "out", provider: "github", subjectId: "2004" },
      slackUserId: "U_OUT",
    });
    const { fixture } = await prepareSlackParentConversation();
    const [creator] = await getDb()
      .select({ id: juniorIdentities.id })
      .from(juniorIdentities)
      .where(eq(juniorIdentities.providerSubjectId, person.userId));
    await recordConversationParticipant(getSqlExecutor(), {
      actorIdentityId: creator!.id,
      atMs: Date.now(),
      conversationId: slackParentConversationId,
    });
    await makeConversationPrivate();
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
      const unassigned: unknown[] = [];
      mswServer.use(
        http.delete(
          "https://api.github.com/repos/getsentry/junior/issues/4254/assignees",
          async ({ request }) => {
            const removed = (await request.json()) as { assignees: string[] };
            unassigned.push(removed);
            // GitHub sends `unassigned` before it answers Pat's removal,
            // which leaves nobody with a linked account on the issue.
            if (removed.assignees.includes("pat")) {
              await sendGitHubWebhook(
                "issues",
                issueEvent(body, "unassigned", ["nolink"], {
                  assignee: { login: "pat" },
                }),
              );
            }
            return HttpResponse.json({ assignees: [] });
          },
        ),
      );
      const body = await createIssue();

      // Nobody on the issue has a linked account, so it gets no item. It is
      // never up for grabs.
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["nolink"], {
          assignee: { login: "nolink" },
        }),
      );
      expect(await issueItem()).toBeUndefined();

      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["nolink", "out"], {
          assignee: { login: "out" },
        }),
      );
      const item = await issueItem();
      expect(item).toMatchObject({
        assignees: ["out@example.com"],
        status: "open",
      });

      // Out sees the item and the issue, but not the private Conversation.
      const [card] = (await inboxOf("out@example.com")).filter(
        (listed) => listed.id === item!.id,
      );
      expect(card).toMatchObject({
        canAct: true,
        conversationIds: [],
        body: expect.stringContaining(ISSUE_URL),
        subject: {
          // Dismiss says that it also unassigns Out on GitHub.
          dismissNote: "Also unassigns you on GitHub.",
          kind: "github:issue",
        },
      });
      // No root tells the dashboard that the viewer cannot see it.
      expect(card).not.toHaveProperty("rootConversationId");
      expect(card).not.toHaveProperty("addedByLabel");

      // Pat is assigned too. Out's dismiss leaves Pat on the item, though
      // Out can no longer see it.
      await sendGitHubWebhook(
        "issues",
        issueEvent(body, "assigned", ["nolink", "out", "pat"], {
          assignee: { login: "pat" },
        }),
      );
      expect(await dismissAs("out@example.com", item!.id)).toBe(200);
      expect(unassigned).toEqual([{ assignees: ["out"] }]);
      expect(await issueItem()).toMatchObject({
        assignees: ["pat@example.com"],
        status: "open",
      });

      // Pat's dismiss from a Slack card is the last one. Its webhook closes
      // the item while the dismiss waits on GitHub, and the item still
      // closes as Pat's dismiss, as the first close.
      await actOnInboxItem({
        action: "dismiss",
        delivery: {
          queue: createConversationWorkQueueTestAdapter(),
          show: async () => {},
        },
        firstCloseOnly: true,
        id: item!.id,
        user: await signedInViewer("pat@example.com"),
      });
      expect(unassigned).toEqual([
        { assignees: ["out"] },
        { assignees: ["pat"] },
      ]);
      expect(await issueItem()).toMatchObject({ status: "dismissed" });
    } finally {
      setDashboardConversationLinkOptions(previousDashboard);
      await fixture.close();
    }
  });
});
