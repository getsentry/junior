import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import { createDeleteAutomationTool } from "@/chat/automations/tools/delete";
import { createRunAutomationNowTool } from "@/chat/automations/tools/run-now";
import { createSearchAutomationsTool } from "@/chat/automations/tools/search";
import { automationToolContext } from "@/chat/automations/tool-access";
import {
  context,
  createTask,
  execute,
  EVENT_CATALOG,
  teamId,
} from "../fixtures/event-automations";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { loadPendingMessageCards } from "@/chat/conversations/pending-cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getEventAutomation } from "@/chat/event-automations/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorAutomations } from "@/db/schema/automations";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "event-automation-test-secret";
});

let fixture: LocalJuniorSqlFixture;

describe("event automation management", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    await getConversationStore().recordActivity({
      conversationId: "test:event-annotations",
      destination: {
        platform: "local",
        conversationId: "test:event-annotations",
      },
      source: "local",
      nowMs: Date.now(),
    });
  });

  afterEach(async () => {
    const db = fixture.sql.db();
    await db
      .delete(juniorAutomations)
      .where(eq(juniorAutomations.teamId, teamId));
    await fixture.close();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("lists in one channel and manages public tasks by id from another", async () => {
    // Slack turns record the public Destination before tools run.
    await getConversationStore().recordActivity({
      conversationId: `slack:${teamId}:C123:public-task`,
      actor: { platform: "slack", slackUserId: "U123", teamId },
      destination: { platform: "slack", teamId, channelId: "C123" },
      channelName: "reviews",
      visibility: "public",
    });
    const created = await createTask(
      "Address the requested changes.",
      undefined,
      undefined,
      context("U123", "C123", "public", "1700000000.100000"),
    );
    expect(created).not.toHaveProperty("data");

    const listed = (await execute(
      createSearchAutomationsTool(
        automationToolContext(
          context("U999", "C123", "public", "1700000000.200000"),
        ),
        EVENT_CATALOG,
      ),
      {},
    )) as {
      automations: Array<{
        createdBy: { slackUserId: string };
        id: string;
      }>;
    };
    expect(listed).not.toHaveProperty("data");
    expect(listed.automations.map((task) => task.id)).toEqual([
      created.automation.id,
    ]);
    expect(listed.automations[0]).toMatchObject({
      trigger: { available: true },
    });
    const search = async (input: Record<string, unknown>) =>
      (
        (await execute(
          createSearchAutomationsTool(
            automationToolContext(context("U999", "COTHER")),
            EVENT_CATALOG,
          ),
          input,
        )) as { automations: Array<{ id: string }> }
      ).automations.map((task) => task.id);
    // A public automation is found from anywhere in the workspace, but not
    // as an automation of another conversation.
    expect(await search({})).toEqual([created.automation.id]);
    expect(await search({ scope: "current_conversation" })).toEqual([]);
    expect(await search({ scope: "mine" })).toEqual([]);
    expect(await search({ type: "event" })).toEqual([created.automation.id]);
    expect(await search({ type: "scheduled" })).toEqual([]);
    // Only a matching event starts an event automation.
    await expect(
      execute(
        createRunAutomationNowTool(
          automationToolContext(context("U999", "COTHER")),
          EVENT_CATALOG,
        ),
        { automationId: created.automation.id },
      ),
    ).rejects.toThrow("Only scheduled automations can run now.");
    const update = (input: Record<string, unknown>) =>
      execute(
        createUpdateAutomationTool(
          automationToolContext(context("U999", "COTHER")),
          EVENT_CATALOG,
        ),
        { automationId: created.automation.id, ...input },
      );
    await update({ status: "paused" });
    // The paused task still uses the creator's credentials.
    await expect(update({ status: "active" })).rejects.toThrow(
      "Only the creator can resume it or run it now.",
    );
    await update({ instruction: "Change a public task from another channel." });
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      credentialMode: "system",
      status: "paused",
      task: { text: "Change a public task from another channel." },
    });
    await update({ status: "active" });
    // Setting the current status again changes nothing.
    await expect(update({ status: "active" })).resolves.toMatchObject({
      automation: { status: "active" },
    });
    await execute(
      createDeleteAutomationTool(
        automationToolContext(context("U999", "COTHER")),
        EVENT_CATALOG,
      ),
      { automationId: created.automation.id },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({ status: "deleted" });
  });

  it("keeps private task updates in the owning channel or DM", async () => {
    const created = await createTask(
      "Address the requested changes.",
      undefined,
      undefined,
      context("U123", "D123", "private"),
    );

    await expect(
      execute(
        createUpdateAutomationTool(
          automationToolContext(context("U999", "COTHER", "public")),
          EVENT_CATALOG,
        ),
        {
          automationId: created.automation.id,
          instruction: "Change a private task from another channel.",
        },
      ),
    ).rejects.toThrow("Automation was not found.");
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      task: { text: "Address the requested changes." },
    });
  });

  it("reports when a stored task trigger is not currently available", async () => {
    const created = await createTask("Address the requested changes.");

    const listed = (await execute(
      createSearchAutomationsTool(automationToolContext(context()), {}),
      {},
    )) as {
      automations: Array<{ id: string; trigger: { available: boolean } }>;
    };
    expect(listed.automations).toEqual([
      expect.objectContaining({
        id: created.automation.id,
        trigger: expect.objectContaining({
          available: false,
          problems: ["The plugin for this source is not enabled."],
        }),
      }),
    ]);
  });

  it("keeps creator credentials bound to creator-authorized execution", async () => {
    const created = await createTask("Address the requested changes.");

    await expect(
      execute(
        createUpdateAutomationTool(
          automationToolContext(context("U999")),
          EVENT_CATALOG,
        ),
        {
          automationId: created.automation.id,
          credentialMode: "creator",
        },
      ),
    ).rejects.toThrow(
      "Only the event automation creator can enable creator credential use.",
    );
    await execute(
      createUpdateAutomationTool(
        automationToolContext(context("U999")),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
        trigger: {
          type: "event",
          namespace: "github",
          identifier: "getsentry/junior#1174",
          resourceType: "review_target",
          label: "Updated GitHub PR label",
          events: ["pull_request.review.changes_requested"],
        },
      },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      credentialMode: "creator",
      trigger: {
        label: "Updated GitHub PR label",
        resourceType: "review_target",
      },
    });

    await execute(
      createUpdateAutomationTool(
        automationToolContext(context("U999")),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
        trigger: {
          type: "event",
          namespace: "github",
          identifier: "getsentry/junior#1176",
          resourceType: "pull_request",
          label: "GitHub PR getsentry/junior#1176",
          events: ["pull_request.review.changes_requested"],
        },
      },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      credentialMode: "system",
      trigger: { identifier: "getsentry/junior#1176" },
    });

    await execute(
      createUpdateAutomationTool(
        automationToolContext(context()),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
        instruction: null,
        trigger: null,
        credentialMode: "creator",
      },
    );
    await execute(
      createUpdateAutomationTool(
        automationToolContext(context("U999")),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
        instruction: "Address the requested changes.",
      },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      credentialMode: "creator",
    });
    await execute(
      createUpdateAutomationTool(
        automationToolContext(context("U999")),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
        instruction: "Only summarize the requested changes.",
      },
    );
    expect(
      await getEventAutomation(fixture.sql.db(), created.automation.id),
    ).toMatchObject({
      credentialMode: "system",
      task: { text: "Only summarize the requested changes." },
    });
  });

  it("deletes an event automation", async () => {
    const created = await createTask(
      "Summarize the requested changes.",
      "event-automation-replayed-create",
    );

    const deleted = await execute(
      createDeleteAutomationTool(
        automationToolContext(context("U999")),
        EVENT_CATALOG,
      ),
      {
        automationId: created.automation.id,
      },
    );
    expect(deleted).not.toHaveProperty("cards");
    const conversationId = "local:delete-card";
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      source: "internal",
      visibility: "public",
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 1,
        data: {
          type: "tool_result",
          toolName: "createAutomation",
          details: created,
          isError: false,
        },
      },
      {
        createdAtMs: 2,
        data: {
          type: "tool_result",
          toolName: "deleteAutomation",
          details: deleted,
          isError: false,
        },
      },
    ]);
    const cards = await loadPendingMessageCards(conversationId);
    expect(cards).toEqual([]);
    await expect(
      execute(
        createUpdateAutomationTool(
          automationToolContext(context("U999")),
          EVENT_CATALOG,
        ),
        {
          automationId: created.automation.id,
          instruction: "Try to update the deleted task.",
        },
      ),
    ).rejects.toThrow("Automation was not found.");
    const listed = (await execute(
      createSearchAutomationsTool(
        automationToolContext(context()),
        EVENT_CATALOG,
      ),
      {},
    )) as {
      automations: unknown[];
    };
    expect(listed.automations).toEqual([]);

    const recreated = await createTask(
      "Summarize the requested changes after delete.",
      "event-automation-replayed-create",
    );
    expect(recreated.automation).toMatchObject({
      id: created.automation.id,
      instruction: "Summarize the requested changes after delete.",
    });
    await expect(
      getEventAutomation(fixture.sql.db(), created.automation.id),
    ).resolves.toMatchObject({
      id: created.automation.id,
      status: "active",
      task: { text: "Summarize the requested changes after delete." },
    });
  });
});
