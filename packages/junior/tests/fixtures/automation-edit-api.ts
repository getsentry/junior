import { Hono } from "hono";
import { expect } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { automationEditSchema } from "@/api/schema/automation";
import { getDb, getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createEventAutomation } from "@/chat/event-automations/store";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { createConfiguredJuniorSqlFixture } from "./sql";

export const destination = {
  platform: "slack" as const,
  channelId: "C123",
  teamId: "T123",
};
export const originalInstruction = "Post the weekly issue digest.";

/**
 * Create a public Automation and a dashboard API app. The `test-viewer`
 * header picks the viewer: its creator, a public reader, or a person with
 * the same Slack ID in another workspace.
 */
export async function setupAutomationEditApi(kind: "scheduled" | "event") {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  for (const [slackUserId, email, teamId] of [
    ["U123", "creator@example.com", "T123"],
    ["U456", "reader@example.com", "T123"],
    ["U123", "foreign@example.com", "TFOREIGN"],
  ] as const) {
    await getConversationStore().recordActivity({
      conversationId: `slack:${teamId}:${slackUserId}:edit`,
      actor: { platform: "slack", slackUserId, email, teamId },
      destination: { ...destination, teamId },
      channelName: "automations",
      visibility: "public",
    });
  }
  const user = await resolveViewerUser("creator@example.com");
  if (!user) throw new Error("Missing creator");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    const viewer = await resolveViewerUser(
      context.req.header("test-viewer") ?? user.email,
    );
    if (!viewer) throw new Error("Missing viewer");
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const id = `${kind}_edit_api`;
  const common = {
    id,
    createdAtMs: Date.now(),
    createdBy: { slackUserId: "U123" },
    credentialMode: "creator" as const,
    destination,
    task: { text: originalInstruction },
    title: "My custom title",
    // Keep an existing Destination that the new editor cannot create.
    outcomes: [
      {
        action: "send_message" as const,
        destination: { ...destination, channelId: "DRETAINED" },
      },
    ],
  };
  if (kind === "scheduled") {
    await saveScheduledAutomation(getDb(), {
      ...common,
      creatorIdentityId: user.identities.find(
        (identity) => identity.provider === "slack",
      )!.id,
      conversationAccess: { audience: "channel", visibility: "public" },
      updatedAtMs: Date.now(),
      status: "blocked",
      statusReason: "Missing credentials",
      nextRunAtMs: Date.now() + 86400000,
      schedule: {
        kind: "recurring",
        timezone: "UTC",
        description: "Every day",
        recurrence: {
          frequency: "daily",
          interval: 1,
          time: { hour: 9, minute: 0 },
          startDate: "2026-01-01",
        },
      },
    });
  } else {
    await createEventAutomation(getDb(), {
      ...common,
      creatorIdentityId: user.identities.find(
        (identity) => identity.provider === "slack",
      )!.id,
      destinationVisibility: "public",
      trigger: {
        namespace: "unavailable",
        resourceType: "issue",
        identifier: "issue-42",
        label: "Old issue",
        events: ["issue.closed"],
        match: { retainedCondition: ["one", "two"] },
      },
    });
  }
  const url = `/api/automations/${id}`;
  const read = async () => {
    const response = await app.request(`${url}/edit`);
    expect(response.status).toBe(200);
    return automationEditSchema.parse(await response.json());
  };
  const patch = (body: unknown, viewer = user.email) =>
    app.request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", "test-viewer": viewer },
      body: JSON.stringify(body),
    });
  const lifecycle = async (
    action: "pause" | "resume",
    revision?: string,
    viewer = user.email,
  ) =>
    app.request(`${url}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", "test-viewer": viewer },
      body: JSON.stringify({
        action,
        revision: revision ?? (await read()).revision,
      }),
    });
  return { app, fixture, id, url, read, patch, lifecycle, user };
}
